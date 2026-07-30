-- EvolvTrack initial schema.
-- Applied by Supabase CLI / GitHub Actions via `supabase db push`.
--
-- This migration sets up:
--   1. Sync schema (accounts, encrypted + plaintext change tables, RLS).
--   2. Realtime publication membership for the change tables.
--   3. License / entitlement system (bearer tokens, HMAC pepper, admin RPCs)
--      and the license gate on sync inserts/updates.
--
-- After applying this migration, bootstrap the first admin manually:
--   insert into public.app_admins (user_id) values ('<your-auth-uid>');

------------------------------------------------------------------------------
-- 1. Sync schema
------------------------------------------------------------------------------

create table if not exists public.sync_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  sync_mode text not null default 'plain',
  e2ee_migration_id text,
  e2ee_migration_direction text,
  migration_owner_device_id text,
  migration_started_at timestamptz,
  migration_updated_at timestamptz,
  migration_completed_at timestamptz,
  plaintext_high_water_mark timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_accounts_sync_mode_check
    check (sync_mode in ('plain', 'migrating_to_e2ee', 'e2ee', 'migrating_to_plain')),
  constraint sync_accounts_e2ee_migration_direction_check
    check (e2ee_migration_direction is null or e2ee_migration_direction in ('enable', 'disable')),
  constraint sync_accounts_migration_has_id_check
    check (sync_mode not in ('migrating_to_e2ee', 'migrating_to_plain') or e2ee_migration_id is not null)
);

create table if not exists public.sync_changes_encrypted (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  aggregate text not null check (aggregate in ('weight', 'injection', 'prescription', 'profile')),
  op text not null check (op in ('upsert', 'delete')),
  ciphertext text not null,
  iv text not null,
  protocol_version int not null,
  encryption_version int not null,
  schema_version int not null,
  created_at timestamptz not null,
  inserted_at timestamptz not null default now()
);

create index if not exists sync_changes_encrypted_user_created_at_idx
  on public.sync_changes_encrypted (user_id, created_at);

create table if not exists public.sync_changes_plain (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  aggregate text not null check (aggregate in ('weight', 'injection', 'prescription', 'profile')),
  op text not null check (op in ('upsert', 'delete')),
  payload jsonb not null,
  protocol_version int not null,
  schema_version int not null,
  created_at timestamptz not null,
  inserted_at timestamptz not null default now()
);

create index if not exists sync_changes_plain_user_created_at_idx
  on public.sync_changes_plain (user_id, created_at);

alter table public.sync_accounts enable row level security;
alter table public.sync_changes_encrypted enable row level security;
alter table public.sync_changes_plain enable row level security;

grant select, insert, update on table public.sync_accounts to authenticated;
grant select, insert, update, delete on table public.sync_changes_encrypted to authenticated;
grant select, insert, update, delete on table public.sync_changes_plain to authenticated;
grant select, insert, update on table public.sync_accounts to service_role;
grant select, insert, update, delete on table public.sync_changes_encrypted to service_role;
grant select, insert, update, delete on table public.sync_changes_plain to service_role;

------------------------------------------------------------------------------
-- 2. Realtime publication
--
-- Realtime is only a notification here — the client still fetches by the
-- `inserted_at` cursor — so the default replica identity (primary key) is
-- sufficient.
------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sync_changes_encrypted'
  ) then
    alter publication supabase_realtime add table public.sync_changes_encrypted;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sync_changes_plain'
  ) then
    alter publication supabase_realtime add table public.sync_changes_plain;
  end if;
end $$;

------------------------------------------------------------------------------
-- 3. License + entitlement system
--
-- Bearer-token license system that gates cloud sync. A license code is a
-- string the holder presents to claim entitlement; whoever has the code
-- controls it. Codes are never stored in plaintext — only an HMAC keyed with
-- a server-side pepper. The pepper lives in a private schema invisible to
-- PostgREST clients.
--
-- All client-facing operations go through SECURITY DEFINER RPCs so the
-- license table itself can stay locked down. RLS on the sync_changes_*
-- tables requires an active license for writes.
------------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- Private schema for server-side secrets (pepper) and helpers.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.app_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

-- Generate the license code pepper exactly once, on first migration apply.
-- A DB dump that does not include this row cannot be used to verify codes.
insert into private.app_secrets (key, value)
select 'license_code_pepper', encode(extensions.gen_random_bytes(32), 'hex')
where not exists (
  select 1 from private.app_secrets where key = 'license_code_pepper'
);

-- HMAC a license code with the pepper. Returns lowercase hex.
create or replace function private.hash_code(p_code text)
returns text
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_pepper text;
begin
  select value into v_pepper from private.app_secrets where key = 'license_code_pepper';
  if v_pepper is null then
    raise exception 'license_code_pepper missing';
  end if;
  return encode(extensions.hmac(p_code, v_pepper, 'sha256'), 'hex');
end;
$$;

-- Generate a single license code: EVOLV-XXXXX-XXXXX-XXXXX using a
-- 32-character Crockford-style alphabet (no I, L, O, U). 256 % 32 = 0 so
-- byte % 32 is unbiased. 15 random chars × 5 bits = 75 bits of entropy.
create or replace function private.generate_code()
returns text
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea;
  v_segment text;
  v_segments text[] := array[]::text[];
begin
  for v_seg_idx in 1..3 loop
    v_bytes := extensions.gen_random_bytes(5);
    v_segment := '';
    for v_i in 0..4 loop
      v_segment := v_segment || substr(v_alphabet, 1 + (get_byte(v_bytes, v_i) % 32), 1);
    end loop;
    v_segments := array_append(v_segments, v_segment);
  end loop;
  return 'EVOLV-' || array_to_string(v_segments, '-');
end;
$$;

-- Admin registry.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;
-- No policies: locked down. Access is mediated by SECURITY DEFINER functions.

create or replace function private.is_admin(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.app_admins where user_id = p_uid);
$$;

-- Licenses table.
create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  code_hmac text not null unique,
  code_prefix text not null,
  tier text not null,
  status text not null default 'unclaimed',
  claimed_by_user_id uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  buyer_email text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint licenses_tier_check
    check (tier in ('monthly', 'yearly', 'lifetime')),
  constraint licenses_status_check
    check (status in ('unclaimed', 'active', 'expired', 'revoked')),
  constraint licenses_claimed_consistency
    check (
      (status = 'unclaimed' and claimed_by_user_id is null and claimed_at is null)
      or (status <> 'unclaimed')
    )
);

create index if not exists licenses_claimed_by_user_id_idx
  on public.licenses (claimed_by_user_id);
create index if not exists licenses_status_idx
  on public.licenses (status);

alter table public.licenses enable row level security;
-- No policies: locked down. All access via SECURITY DEFINER RPCs below.

-- Entitlement check. Public so RLS policies can reference it cleanly.
-- Treats period_end as the source of truth; status='expired' is bookkeeping.
create or replace function public.has_active_license(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.licenses
    where claimed_by_user_id = p_uid
      and status = 'active'
      and (period_end is null or period_end > now())
  );
$$;

grant execute on function public.has_active_license(uuid) to authenticated, service_role;

------------------------------------------------------------------------------
-- 4. RLS policies for sync tables
--
-- Read: any authenticated user can read their own rows (license lapse does
-- not lock them out of data they already pushed).
-- Write: insert/update additionally require an active license.
-- Delete on changes tables: own rows only.
------------------------------------------------------------------------------

create policy "Users can read their sync account"
  on public.sync_accounts
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their sync account"
  on public.sync_accounts
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their sync account"
  on public.sync_accounts
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can read their encrypted changes"
  on public.sync_changes_encrypted
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their encrypted changes"
  on public.sync_changes_encrypted
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
  );

create policy "Users can update their encrypted changes"
  on public.sync_changes_encrypted
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
  );

create policy "Users can delete their encrypted changes"
  on public.sync_changes_encrypted
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their plain changes"
  on public.sync_changes_plain
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their plain changes"
  on public.sync_changes_plain
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
  );

create policy "Users can update their plain changes"
  on public.sync_changes_plain
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
  );

create policy "Users can delete their plain changes"
  on public.sync_changes_plain
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

------------------------------------------------------------------------------
-- 5. End-user license RPCs
------------------------------------------------------------------------------

-- Claim an unclaimed license code for the calling user. Idempotent if the
-- caller already holds this exact license.
create or replace function public.claim_license(p_code text)
returns table (
  license_id uuid,
  tier text,
  status text,
  period_end timestamptz,
  code_prefix text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_hmac text;
  v_row public.licenses%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'invalid_code';
  end if;

  v_hmac := private.hash_code(upper(trim(p_code)));

  select * into v_row from public.licenses where code_hmac = v_hmac for update;
  if not found then
    raise exception 'license_not_found';
  end if;

  if v_row.status = 'revoked' then
    raise exception 'license_revoked';
  end if;

  if v_row.claimed_by_user_id is not null and v_row.claimed_by_user_id <> v_uid then
    raise exception 'license_already_claimed';
  end if;

  if v_row.claimed_by_user_id is null then
    update public.licenses
      set claimed_by_user_id = v_uid,
          claimed_at = now(),
          status = 'active',
          updated_at = now()
      where id = v_row.id;
  end if;

  return query
    select l.id, l.tier, l.status, l.period_end, l.code_prefix
    from public.licenses l where l.id = v_row.id;
end;
$$;

-- Release the calling user's license back to unclaimed. Used for transfer.
create or replace function public.release_license()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  update public.licenses
    set claimed_by_user_id = null,
        claimed_at = null,
        status = 'unclaimed',
        updated_at = now()
    where claimed_by_user_id = v_uid;
end;
$$;

-- Rotate the code on the calling user's claimed license. Old code becomes
-- invalid immediately; new raw code is returned exactly once.
create or replace function public.regenerate_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_new_code text;
  v_new_hmac text;
  v_attempts int := 0;
  v_license_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select id into v_license_id
    from public.licenses
    where claimed_by_user_id = v_uid
    for update;
  if not found then
    raise exception 'no_license';
  end if;

  -- Retry on the astronomically unlikely event of an HMAC collision.
  loop
    v_new_code := private.generate_code();
    v_new_hmac := private.hash_code(v_new_code);
    begin
      update public.licenses
        set code_hmac = v_new_hmac,
            code_prefix = substr(v_new_code, 1, 10),
            updated_at = now()
        where id = v_license_id;
      exit;
    exception when unique_violation then
      v_attempts := v_attempts + 1;
      if v_attempts > 5 then
        raise;
      end if;
    end;
  end loop;

  return v_new_code;
end;
$$;

-- Read-only view of the calling user's license. Returns no rows if unclaimed.
create or replace function public.license_status()
returns table (
  license_id uuid,
  tier text,
  status text,
  period_start timestamptz,
  period_end timestamptz,
  code_prefix text,
  claimed_at timestamptz,
  is_active boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    l.id,
    l.tier,
    l.status,
    l.period_start,
    l.period_end,
    l.code_prefix,
    l.claimed_at,
    (l.status = 'active' and (l.period_end is null or l.period_end > now()))
  from public.licenses l
  where l.claimed_by_user_id = auth.uid();
$$;

------------------------------------------------------------------------------
-- 6. Admin RPCs. All guard with private.is_admin(auth.uid()).
------------------------------------------------------------------------------

create or replace function public.admin_generate_licenses(
  p_tier text,
  p_count int default 1,
  p_note text default null,
  p_period_end timestamptz default null
)
returns table (license_id uuid, code text, code_prefix text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_hmac text;
  v_id uuid;
  v_attempts int;
begin
  if not private.is_admin(v_uid) then
    raise exception 'not_admin';
  end if;
  if p_count < 1 or p_count > 500 then
    raise exception 'invalid_count';
  end if;
  if p_tier not in ('monthly', 'yearly', 'lifetime') then
    raise exception 'invalid_tier';
  end if;

  for v_i in 1..p_count loop
    v_attempts := 0;
    loop
      v_code := private.generate_code();
      v_hmac := private.hash_code(v_code);
      begin
        insert into public.licenses (code_hmac, code_prefix, tier, note, period_end)
          values (v_hmac, substr(v_code, 1, 10), p_tier, p_note, p_period_end)
          returning id into v_id;
        exit;
      exception when unique_violation then
        v_attempts := v_attempts + 1;
        if v_attempts > 5 then raise; end if;
      end;
    end loop;
    license_id := v_id;
    code := v_code;
    code_prefix := substr(v_code, 1, 10);
    return next;
  end loop;
end;
$$;

create or replace function public.admin_change_tier(
  p_license_id uuid,
  p_new_tier text,
  p_new_period_end timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;
  if p_new_tier not in ('monthly', 'yearly', 'lifetime') then
    raise exception 'invalid_tier';
  end if;
  update public.licenses
    set tier = p_new_tier,
        period_end = p_new_period_end,
        updated_at = now()
    where id = p_license_id;
  if not found then
    raise exception 'license_not_found';
  end if;
end;
$$;

create or replace function public.admin_revoke(
  p_license_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;
  update public.licenses
    set status = 'revoked',
        claimed_by_user_id = null,
        claimed_at = null,
        note = coalesce(note || E'\n', '') || 'revoked: ' || coalesce(p_reason, '(no reason)'),
        updated_at = now()
    where id = p_license_id;
  if not found then
    raise exception 'license_not_found';
  end if;
end;
$$;

create or replace function public.admin_set_note(
  p_license_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;
  update public.licenses
    set note = p_note, updated_at = now()
    where id = p_license_id;
  if not found then
    raise exception 'license_not_found';
  end if;
end;
$$;

create or replace function public.admin_list_licenses(
  p_limit int default 100,
  p_offset int default 0,
  p_filter text default null
)
returns table (
  license_id uuid,
  code_prefix text,
  tier text,
  status text,
  claimed_by_user_id uuid,
  claimed_by_email text,
  claimed_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  buyer_email text,
  note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;
  return query
    select
      l.id,
      l.code_prefix,
      l.tier,
      l.status,
      l.claimed_by_user_id,
      u.email::text,
      l.claimed_at,
      l.period_start,
      l.period_end,
      l.buyer_email,
      l.note,
      l.created_at
    from public.licenses l
    left join auth.users u on u.id = l.claimed_by_user_id
    where p_filter is null
       or l.code_prefix ilike '%' || p_filter || '%'
       or l.note ilike '%' || p_filter || '%'
       or l.buyer_email ilike '%' || p_filter || '%'
       or u.email ilike '%' || p_filter || '%'
    order by l.created_at desc
    limit greatest(1, least(p_limit, 500))
    offset greatest(0, p_offset);
end;
$$;

create or replace function public.admin_grant_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;
  insert into public.app_admins (user_id) values (p_user_id)
    on conflict (user_id) do nothing;
end;
$$;

create or replace function public.admin_revoke_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'cannot_revoke_self';
  end if;
  delete from public.app_admins where user_id = p_user_id;
end;
$$;

create or replace function public.admin_list_admins()
returns table (user_id uuid, email text, granted_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;
  return query
    select a.user_id, u.email::text, a.granted_at
    from public.app_admins a
    left join auth.users u on u.id = a.user_id
    order by a.granted_at asc;
end;
$$;

create or replace function public.am_i_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.is_admin(auth.uid());
$$;

------------------------------------------------------------------------------
-- 7. Function grants. Lock everything down to authenticated only; no anon.
------------------------------------------------------------------------------

revoke execute on function public.claim_license(text) from public, anon;
revoke execute on function public.release_license() from public, anon;
revoke execute on function public.regenerate_code() from public, anon;
revoke execute on function public.license_status() from public, anon;
revoke execute on function public.admin_generate_licenses(text, int, text, timestamptz) from public, anon;
revoke execute on function public.admin_change_tier(uuid, text, timestamptz) from public, anon;
revoke execute on function public.admin_revoke(uuid, text) from public, anon;
revoke execute on function public.admin_set_note(uuid, text) from public, anon;
revoke execute on function public.admin_list_licenses(int, int, text) from public, anon;
revoke execute on function public.admin_grant_admin(uuid) from public, anon;
revoke execute on function public.admin_revoke_admin(uuid) from public, anon;
revoke execute on function public.admin_list_admins() from public, anon;
revoke execute on function public.am_i_admin() from public, anon;

grant execute on function public.claim_license(text) to authenticated;
grant execute on function public.release_license() to authenticated;
grant execute on function public.regenerate_code() to authenticated;
grant execute on function public.license_status() to authenticated;
grant execute on function public.admin_generate_licenses(text, int, text, timestamptz) to authenticated;
grant execute on function public.admin_change_tier(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_revoke(uuid, text) to authenticated;
grant execute on function public.admin_set_note(uuid, text) to authenticated;
grant execute on function public.admin_list_licenses(int, int, text) to authenticated;
grant execute on function public.admin_grant_admin(uuid) to authenticated;
grant execute on function public.admin_revoke_admin(uuid) to authenticated;
grant execute on function public.admin_list_admins() to authenticated;
grant execute on function public.am_i_admin() to authenticated;

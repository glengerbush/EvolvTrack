-- Fence transition completion against concurrent sync writes and enforce the
-- active DEK version at RLS, so no stale device can recreate an obsolete row.

create or replace function public.sync_dek_version_allows(p_uid uuid, p_dek_version int)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (p_uid = auth.uid() or auth.role() = 'service_role')
    and coalesce((
      select case sa.sync_mode
        when 'e2ee' then p_dek_version = sa.active_dek_version
        when 'migrating_to_e2ee' then p_dek_version = sa.pending_dek_version
        when 'rotating_e2ee_key' then
          p_dek_version = sa.active_dek_version or p_dek_version = sa.pending_dek_version
        else false
      end
      from public.sync_accounts sa
      where sa.user_id = p_uid
    ), false);
$$;

revoke execute on function public.sync_dek_version_allows(uuid, int) from public, anon;
grant execute on function public.sync_dek_version_allows(uuid, int)
  to authenticated, service_role;

drop policy if exists "Encrypted inserts use an allowed DEK version"
  on public.sync_changes_encrypted;
create policy "Encrypted inserts use an allowed DEK version"
  on public.sync_changes_encrypted
  as restrictive
  for insert
  to authenticated
  with check (
    public.sync_dek_version_allows((select auth.uid()), dek_version)
  );

drop policy if exists "Encrypted updates use an allowed DEK version"
  on public.sync_changes_encrypted;
create policy "Encrypted updates use an allowed DEK version"
  on public.sync_changes_encrypted
  as restrictive
  for update
  to authenticated
  using (
    public.sync_dek_version_allows((select auth.uid()), dek_version)
  )
  with check (
    public.sync_dek_version_allows((select auth.uid()), dek_version)
  );

drop policy if exists "Wrapped-key inserts use an allowed DEK version"
  on public.wrapped_keys;
create policy "Wrapped-key inserts use an allowed DEK version"
  on public.wrapped_keys
  as restrictive
  for insert
  to authenticated
  with check (
    public.sync_dek_version_allows((select auth.uid()), dek_version)
  );

drop policy if exists "Wrapped-key updates use an allowed DEK version"
  on public.wrapped_keys;
create policy "Wrapped-key updates use an allowed DEK version"
  on public.wrapped_keys
  as restrictive
  for update
  to authenticated
  using (
    public.sync_dek_version_allows((select auth.uid()), dek_version)
  )
  with check (
    public.sync_dek_version_allows((select auth.uid()), dek_version)
  );

create or replace function public.complete_sync_transition(
  p_migration_id text,
  p_owner_device_id text,
  p_to text,
  p_active_version int
)
returns table (mode text, active_version int, pending_version int)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_owner text;
  v_mig text;
  v_mode text;
  v_direction text;
  v_active int;
  v_pending int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select
    sa.migration_owner_device_id,
    sa.e2ee_migration_id,
    sa.sync_mode,
    sa.e2ee_migration_direction,
    sa.active_dek_version,
    sa.pending_dek_version
  into v_owner, v_mig, v_mode, v_direction, v_active, v_pending
  from public.sync_accounts sa
  where sa.user_id = v_uid
  for update;

  if not found
     or v_mig is distinct from p_migration_id
     or v_owner is distinct from p_owner_device_id then
    raise exception 'sync_transition_conflict';
  end if;

  -- Conflicts with INSERT/UPDATE/DELETE table locks. Once acquired, every
  -- source row that could have started under the transition is visible, and
  -- no new one can land until the authoritative mode/version is finalized.
  lock table public.sync_changes_plain, public.sync_changes_encrypted, public.wrapped_keys
    in share row exclusive mode;

  if v_direction = 'enable' then
    if v_mode <> 'migrating_to_e2ee'
       or p_to <> 'e2ee'
       or p_active_version is distinct from v_pending
       or p_active_version is null
       or exists (select 1 from public.sync_changes_plain where user_id = v_uid)
       or not exists (
         select 1 from public.wrapped_keys
         where user_id = v_uid and dek_version = p_active_version
       ) then
      raise exception 'sync_transition_postcondition';
    end if;
  elsif v_direction = 'disable' then
    if v_mode <> 'migrating_to_plain'
       or p_to <> 'plain'
       or p_active_version is not null
       or exists (select 1 from public.sync_changes_encrypted where user_id = v_uid) then
      raise exception 'sync_transition_postcondition';
    end if;
    delete from public.wrapped_keys where user_id = v_uid;
  elsif v_direction = 'rotate' then
    if v_mode <> 'rotating_e2ee_key'
       or p_to <> 'e2ee'
       or p_active_version is distinct from v_pending
       or p_active_version is null
       or exists (
         select 1 from public.sync_changes_encrypted
         where user_id = v_uid and dek_version is distinct from p_active_version
       )
       or not exists (
         select 1 from public.wrapped_keys
         where user_id = v_uid and dek_version = p_active_version
       ) then
      raise exception 'sync_transition_postcondition';
    end if;
    delete from public.wrapped_keys
    where user_id = v_uid and dek_version <> p_active_version;
  else
    raise exception 'sync_transition_postcondition';
  end if;

  update public.sync_accounts sa
     set sync_mode = p_to,
         migration_completed_at = now(),
         migration_updated_at = now(),
         active_dek_version = p_active_version,
         pending_dek_version = null,
         updated_at = now()
   where sa.user_id = v_uid;

  return query
    select sa.sync_mode, sa.active_dek_version, sa.pending_dek_version
    from public.sync_accounts sa
    where sa.user_id = v_uid;
end;
$$;

grant execute on function public.complete_sync_transition(text, text, text, int)
  to authenticated, service_role;

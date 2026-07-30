-- Prevent authenticated callers from using SECURITY DEFINER policy helpers to
-- probe another known user UUID. The helpers must stay executable by
-- `authenticated` because RLS policies call them, but their answers are only
-- meaningful for the current JWT subject (or the service role).

create or replace function public.has_active_license(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (p_uid = auth.uid() or auth.role() = 'service_role')
    and exists (
      select 1 from public.licenses
      where claimed_by_user_id = p_uid
        and status = 'active'
        and (period_end is null or period_end > now())
    );
$$;

create or replace function public.sync_mode_allows_plain(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (p_uid = auth.uid() or auth.role() = 'service_role')
    and coalesce(
      (select sync_mode in ('plain', 'migrating_to_plain')
         from public.sync_accounts where user_id = p_uid),
      true
    );
$$;

create or replace function public.sync_mode_allows_encrypted(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (p_uid = auth.uid() or auth.role() = 'service_role')
    and coalesce(
      (select sync_mode in ('e2ee', 'migrating_to_e2ee', 'rotating_e2ee_key')
         from public.sync_accounts where user_id = p_uid),
      false
    );
$$;

revoke execute on function public.has_active_license(uuid) from public, anon;
revoke execute on function public.sync_mode_allows_plain(uuid) from public, anon;
revoke execute on function public.sync_mode_allows_encrypted(uuid) from public, anon;

grant execute on function public.has_active_license(uuid) to authenticated, service_role;
grant execute on function public.sync_mode_allows_plain(uuid) to authenticated, service_role;
grant execute on function public.sync_mode_allows_encrypted(uuid) to authenticated, service_role;

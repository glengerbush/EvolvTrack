-- Finalizing a disable must remove wrapped keys under the same account-row lock.
-- A later enable cannot create its replacement bundle until this transaction
-- commits, eliminating the client-side finalize/delete race.
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
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select sa.migration_owner_device_id, sa.e2ee_migration_id
    into v_owner, v_mig
    from public.sync_accounts sa
   where sa.user_id = v_uid
   for update;

  if not found
     or v_mig is distinct from p_migration_id
     or v_owner is distinct from p_owner_device_id then
    raise exception 'sync_transition_conflict';
  end if;

  if p_to = 'plain' then
    delete from public.wrapped_keys where user_id = v_uid;
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

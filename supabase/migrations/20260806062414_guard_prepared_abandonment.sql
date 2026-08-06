-- Safe cancellation exists only before any sync-log transfer has begun.
create or replace function public.abandon_sync_transition(
  p_migration_id text,
  p_owner_device_id text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_direction text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select sa.e2ee_migration_direction
    into v_direction
    from public.sync_accounts sa
   where sa.user_id = v_uid
     and sa.e2ee_migration_id = p_migration_id
     and sa.migration_owner_device_id = p_owner_device_id
     and sa.e2ee_transition_phase = 'preparing'
   for update;

  if not found then
    raise exception 'sync_transition_conflict';
  end if;

  update public.sync_accounts
     set sync_mode = case when v_direction = 'enable' then 'plain' else 'e2ee' end,
         pending_dek_version = null,
         migration_completed_at = now(),
         migration_updated_at = now(),
         updated_at = now()
   where user_id = v_uid;
end;
$$;

revoke execute on function public.abandon_sync_transition(text, text) from public, anon;
grant execute on function public.abandon_sync_transition(text, text) to authenticated, service_role;

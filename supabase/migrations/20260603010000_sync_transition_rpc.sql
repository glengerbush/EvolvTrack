-- Atomic, server-side claim of an E2EE sync-mode transition.
--
-- Cross-device mutual exclusion: only one device may move the account into a
-- migrating / rotating state at a time. The client-side gate (local sync_mode)
-- can race when two devices act before either has reconciled, so the
-- authoritative check lives here, inside a single locked statement: the account
-- is locked (FOR UPDATE), its current mode is checked against the modes the
-- caller is allowed to start from, and the transition is applied — all atomic.
-- If another device already moved the account out of an expected starting mode,
-- the call raises `sync_transition_conflict` and the client aborts.
--
-- It also allocates the next DEK version atomically (for enable / rotate) so two
-- concurrent rotations can't pick the same version.
--
-- Returns the resulting mode + the active/pending DEK versions. Output columns
-- are named distinctly from the table columns to avoid plpgsql ambiguity.

create or replace function public.begin_sync_transition(
  p_from text[],
  p_to text,
  p_migration_id text,
  p_direction text,
  p_owner_device_id text,
  p_allocate_new_dek boolean
)
returns table (mode text, active_version int, pending_version int)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current text;
  v_active int;
  v_pending int;
  v_found boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select sa.sync_mode, sa.active_dek_version
    into v_current, v_active
    from public.sync_accounts sa
   where sa.user_id = v_uid
   for update;
  v_found := found;

  if v_found then
    if not (v_current = any (p_from)) then
      raise exception 'sync_transition_conflict';
    end if;
    v_pending := case when p_allocate_new_dek then coalesce(v_active, 0) + 1 else null end;
    update public.sync_accounts sa
       set sync_mode = p_to,
           e2ee_migration_id = p_migration_id,
           e2ee_migration_direction = p_direction,
           migration_owner_device_id = p_owner_device_id,
           migration_started_at = now(),
           migration_updated_at = now(),
           migration_completed_at = null,
           pending_dek_version = v_pending,
           updated_at = now()
     where sa.user_id = v_uid;
  else
    -- No row yet (brand-new account). Only valid when the caller is allowed to
    -- start from 'plain' (the implicit default for a missing row).
    if not ('plain' = any (p_from)) then
      raise exception 'sync_transition_conflict';
    end if;
    v_pending := case when p_allocate_new_dek then 1 else null end;
    begin
      insert into public.sync_accounts
        (user_id, sync_mode, e2ee_migration_id, e2ee_migration_direction,
         migration_owner_device_id, migration_started_at, migration_updated_at,
         pending_dek_version, updated_at)
      values
        (v_uid, p_to, p_migration_id, p_direction,
         p_owner_device_id, now(), now(), v_pending, now());
    exception when unique_violation then
      -- Another device inserted the row first.
      raise exception 'sync_transition_conflict';
    end;
  end if;

  return query
    select sa.sync_mode, sa.active_dek_version, sa.pending_dek_version
      from public.sync_accounts sa
     where sa.user_id = v_uid;
end;
$$;

grant execute on function public.begin_sync_transition(text[], text, text, text, text, boolean)
  to authenticated, service_role;

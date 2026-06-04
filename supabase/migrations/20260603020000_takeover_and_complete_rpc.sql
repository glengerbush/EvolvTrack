-- Atomic take-over + guarded completion for E2EE migrations.
--
-- `begin_sync_transition` (20260603010000) already makes the START of a
-- migration mutually exclusive. But ownership hand-off ("Take over on this
-- device") and the finalize step were plain client UPSERTs with no guard, so:
--   * two waiting devices could both "take over" the same migration and then
--     both drive it (the dual-rotation hazard, reintroduced at take-over time);
--   * a slow original owner could finish and clobber the mode/version a newer
--     owner — or a freshly started next transition — had already written
--     (a lost update).
--
-- These two RPCs close that gap with the same locked-row discipline as
-- `begin_sync_transition`.

------------------------------------------------------------------------------
-- claim_migration_owner — atomic compare-and-swap on the owning device.
--
-- The caller passes the owner it last observed (`p_expected_owner_device_id`);
-- the swap only succeeds if the server still agrees. Two devices that both saw
-- owner D1 race here: the row is locked FOR UPDATE, the first swaps D1→itself,
-- and the second then reads the new owner and fails the expectation. So at most
-- one device ever wins a take-over. Claiming a migration you already own is a
-- no-op success (idempotent retries).
------------------------------------------------------------------------------
create or replace function public.claim_migration_owner(
  p_migration_id text,
  p_expected_owner_device_id text,
  p_new_owner_device_id text
)
returns table (mode text, active_version int, pending_version int, owner_device_id text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current text;
  v_owner text;
  v_mig text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select sa.sync_mode, sa.migration_owner_device_id, sa.e2ee_migration_id
    into v_current, v_owner, v_mig
    from public.sync_accounts sa
   where sa.user_id = v_uid
   for update;

  -- No account row, a different migration now in flight, or the account has
  -- already settled into a steady-state mode → there's nothing to take over.
  if not found
     or v_mig is distinct from p_migration_id
     or v_current not in ('migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key') then
    raise exception 'sync_transition_conflict';
  end if;

  -- Already ours: idempotent success (don't bump the heartbeat needlessly).
  if v_owner is not distinct from p_new_owner_device_id then
    return query
      select sa.sync_mode, sa.active_dek_version, sa.pending_dek_version, sa.migration_owner_device_id
        from public.sync_accounts sa
       where sa.user_id = v_uid;
    return;
  end if;

  -- Compare-and-swap: only the device whose expectation still matches the
  -- server's current owner wins. A competing take-over moved the owner already.
  if v_owner is distinct from p_expected_owner_device_id then
    raise exception 'sync_transition_conflict';
  end if;

  update public.sync_accounts sa
     set migration_owner_device_id = p_new_owner_device_id,
         migration_updated_at = now(),
         updated_at = now()
   where sa.user_id = v_uid;

  return query
    select sa.sync_mode, sa.active_dek_version, sa.pending_dek_version, sa.migration_owner_device_id
      from public.sync_accounts sa
     where sa.user_id = v_uid;
end;
$$;

grant execute on function public.claim_migration_owner(text, text, text)
  to authenticated, service_role;

------------------------------------------------------------------------------
-- complete_sync_transition — finalize a migration, but only if we still own it.
--
-- Writes the resulting steady-state mode + DEK version under the same FOR UPDATE
-- lock, and only when the row still names this caller as the owner of THIS
-- migration. A superseded owner (took over elsewhere) raises
-- `sync_transition_conflict` and writes nothing, so it can't clobber the new
-- owner's state. `pending_dek_version` is always cleared on completion;
-- `active_dek_version` is set verbatim (null when disabling).
------------------------------------------------------------------------------
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

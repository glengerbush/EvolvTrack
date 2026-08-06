-- Durable E2EE lifecycle state, optional recovery codes, and atomic Start Fresh.

alter table public.sync_accounts
  add column if not exists e2ee_transition_phase text;

alter table public.sync_accounts
  drop constraint if exists sync_accounts_e2ee_transition_phase_check;
alter table public.sync_accounts
  add constraint sync_accounts_e2ee_transition_phase_check
  check (
    e2ee_transition_phase is null
    or e2ee_transition_phase in ('preparing', 'transferring', 'verifying', 'finalizing')
  );

-- Existing in-flight transitions may already have changed remote data. Treat
-- them conservatively as post-mutation so a deploy never reopens cancellation.
update public.sync_accounts
   set e2ee_transition_phase = 'transferring'
 where sync_mode in ('migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key')
   and e2ee_transition_phase is null;

create or replace function public.set_sync_transition_phase()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.sync_mode in ('migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key') then
    if new.e2ee_transition_phase is null then
      new.e2ee_transition_phase := 'preparing';
    end if;
  else
    new.e2ee_transition_phase := null;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_accounts_set_transition_phase on public.sync_accounts;
create trigger sync_accounts_set_transition_phase
before insert or update of sync_mode, e2ee_transition_phase
on public.sync_accounts
for each row execute function public.set_sync_transition_phase();

create or replace function public.advance_sync_transition_phase(
  p_migration_id text,
  p_owner_device_id text,
  p_phase text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current text;
  v_rank int;
  v_next_rank int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_phase not in ('preparing', 'transferring', 'verifying', 'finalizing') then
    raise exception 'invalid_transition_phase';
  end if;

  select sa.e2ee_transition_phase
    into v_current
    from public.sync_accounts sa
   where sa.user_id = v_uid
     and sa.e2ee_migration_id = p_migration_id
     and sa.migration_owner_device_id = p_owner_device_id
     and sa.sync_mode in ('migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key')
   for update;

  if not found then
    raise exception 'sync_transition_conflict';
  end if;

  v_rank := case v_current
    when 'preparing' then 1
    when 'transferring' then 2
    when 'verifying' then 3
    when 'finalizing' then 4
    else 0
  end;
  v_next_rank := case p_phase
    when 'preparing' then 1
    when 'transferring' then 2
    when 'verifying' then 3
    when 'finalizing' then 4
  end;

  if v_next_rank < v_rank then
    raise exception 'transition_phase_regression';
  end if;

  update public.sync_accounts
     set e2ee_transition_phase = p_phase,
         migration_updated_at = now(),
         updated_at = now()
   where user_id = v_uid;
end;
$$;

revoke execute on function public.advance_sync_transition_phase(text, text, text) from public, anon;
grant execute on function public.advance_sync_transition_phase(text, text, text) to authenticated, service_role;

-- Recovery availability belongs to a specific wrapped DEK. Existing bundles
-- are grandfathered as confirmed; new bundles explicitly write their status.
alter table public.wrapped_keys
  add column if not exists recovery_status text not null default 'confirmed';

alter table public.wrapped_keys
  alter column recovery_salt_b64 drop not null,
  alter column recovery_wrapped_ciphertext drop not null,
  alter column recovery_wrapped_iv drop not null,
  alter column recovery_iterations drop not null,
  alter column recovery_iterations drop default;

alter table public.wrapped_keys
  drop constraint if exists wrapped_keys_recovery_status_check;
alter table public.wrapped_keys
  add constraint wrapped_keys_recovery_status_check
  check (
    (
      recovery_status in ('confirmed', 'unconfirmed')
      and recovery_salt_b64 is not null
      and recovery_wrapped_ciphertext is not null
      and recovery_wrapped_iv is not null
      and recovery_iterations is not null
    )
    or
    (
      recovery_status in ('missing', 'declined')
      and recovery_salt_b64 is null
      and recovery_wrapped_ciphertext is null
      and recovery_wrapped_iv is null
      and recovery_iterations is null
    )
  );

-- One transaction: either every synchronized copy/key is gone and plain mode
-- commits, or PostgreSQL rolls the whole operation back.
create or replace function public.start_fresh_sync(
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
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  perform 1
    from public.sync_accounts sa
   where sa.user_id = v_uid
     and sa.sync_mode = 'migrating_to_plain'
     and sa.e2ee_migration_id = p_migration_id
     and sa.migration_owner_device_id = p_owner_device_id
   for update;

  if not found then
    raise exception 'sync_transition_conflict';
  end if;

  delete from public.sync_changes_plain where user_id = v_uid;
  delete from public.sync_changes_encrypted where user_id = v_uid;
  delete from public.wrapped_keys where user_id = v_uid;

  if exists (select 1 from public.sync_changes_plain where user_id = v_uid)
     or exists (select 1 from public.sync_changes_encrypted where user_id = v_uid)
     or exists (select 1 from public.wrapped_keys where user_id = v_uid) then
    raise exception 'start_fresh_cleanup_incomplete';
  end if;

  update public.sync_accounts
     set sync_mode = 'plain',
         migration_completed_at = now(),
         migration_updated_at = now(),
         active_dek_version = null,
         pending_dek_version = null,
         updated_at = now()
   where user_id = v_uid;
end;
$$;

revoke execute on function public.start_fresh_sync(text, text) from public, anon;
grant execute on function public.start_fresh_sync(text, text) to authenticated, service_role;

-- Wrapped data encryption keys (DEKs) for E2EE recovery.
--
-- Each E2EE user has one row holding their DEK wrapped in two forms:
--   * passphrase-wrapped: the steady-state unlock path.
--   * recovery-code-wrapped: the "I lost my passphrase" path.
--
-- The server never sees the DEK itself or either KEK — only ciphertext. So
-- this table does not weaken the E2EE guarantee; it just gives the client a
-- place to fetch its own wrapped key blobs from a new device.
--
-- `dek_version` bumps on every key rotation. Records encrypted under an old
-- DEK can be identified and re-encrypted; stale clients fetching an older
-- bundle than the one the data was encrypted with will fail to decrypt and
-- can prompt the user to re-sync.

create table if not exists public.wrapped_keys (
  user_id uuid primary key references auth.users (id) on delete cascade,
  dek_version int not null default 1,
  passphrase_salt_b64 text not null,
  passphrase_wrapped_ciphertext text not null,
  passphrase_wrapped_iv text not null,
  recovery_salt_b64 text not null,
  recovery_wrapped_ciphertext text not null,
  recovery_wrapped_iv text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wrapped_keys enable row level security;

grant select, insert, update, delete on table public.wrapped_keys to authenticated;
grant select, insert, update, delete on table public.wrapped_keys to service_role;

create policy "Users can read their wrapped keys"
  on public.wrapped_keys
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their wrapped keys"
  on public.wrapped_keys
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their wrapped keys"
  on public.wrapped_keys
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their wrapped keys"
  on public.wrapped_keys
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

------------------------------------------------------------------------------
-- Extend sync_accounts to admit the new `rotating_e2ee_key` mode.
--
-- Passphrase change + recovery both transition through this mode while a
-- fresh DEK is being installed and every record is being re-encrypted under
-- it. Forward secrecy: an attacker who captured the old DEK can decrypt past
-- ciphertext they captured, but post-rotation rows are encrypted under a key
-- they don't have.
------------------------------------------------------------------------------

alter table public.sync_accounts
  drop constraint if exists sync_accounts_sync_mode_check;
alter table public.sync_accounts
  add constraint sync_accounts_sync_mode_check
  check (sync_mode in ('plain', 'migrating_to_e2ee', 'e2ee', 'migrating_to_plain', 'rotating_e2ee_key'));

alter table public.sync_accounts
  drop constraint if exists sync_accounts_e2ee_migration_direction_check;
alter table public.sync_accounts
  add constraint sync_accounts_e2ee_migration_direction_check
  check (e2ee_migration_direction is null or e2ee_migration_direction in ('enable', 'disable', 'rotate'));

alter table public.sync_accounts
  drop constraint if exists sync_accounts_migration_has_id_check;
alter table public.sync_accounts
  add constraint sync_accounts_migration_has_id_check
  check (
    sync_mode not in ('migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key')
    or e2ee_migration_id is not null
  );

-- E2EE key-rotation hardening: per-row DEK version + multiple wrapped-key
-- bundles per user.
--
-- Why: a passphrase/key rotation must be crash-safe and recoverable on a new
-- device. To do that the server has to hold BOTH the old and the new key
-- bundle until every encrypted row has been re-encrypted under the new DEK, and
-- each row has to advertise which DEK encrypted it so a resumed rotation knows
-- what's left to do. Previously there was exactly one bundle per user and no
-- per-row key version, so a rotation that minted a new bundle orphaned the rows
-- still under the old DEK (the old bundle was overwritten → key lost).
--
-- All changes here are additive and backward-compatible: existing data is a
-- single DEK at version 1.

------------------------------------------------------------------------------
-- 1. Tag every encrypted row with the DEK version that encrypted it.
------------------------------------------------------------------------------
alter table public.sync_changes_encrypted
  add column if not exists dek_version int not null default 1;

-- A resumed rotation scans for rows still under the old version, so index it.
create index if not exists sync_changes_encrypted_user_dek_version_idx
  on public.sync_changes_encrypted (user_id, dek_version);

------------------------------------------------------------------------------
-- 2. Allow more than one wrapped-key bundle per user. Was keyed by user_id
--    alone (one bundle); now keyed by (user_id, dek_version) so the old (vN)
--    and new (vN+1) bundles can coexist for the duration of a rotation.
------------------------------------------------------------------------------
alter table public.wrapped_keys
  drop constraint if exists wrapped_keys_pkey;
alter table public.wrapped_keys
  add constraint wrapped_keys_pkey primary key (user_id, dek_version);

------------------------------------------------------------------------------
-- 3. Track which DEK steady-state sync reads/writes, and the rotation target.
--    `active_dek_version`  — the version current encrypted rows are under.
--    `pending_dek_version` — the version a rotation is migrating toward; null
--                            when no rotation is in progress.
--    Nullable: a null active version means "pre-versioning / treat as 1".
------------------------------------------------------------------------------
alter table public.sync_accounts
  add column if not exists active_dek_version int,
  add column if not exists pending_dek_version int;

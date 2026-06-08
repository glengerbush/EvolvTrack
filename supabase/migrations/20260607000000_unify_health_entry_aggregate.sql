-- Unify the health `weight` + `injection` aggregates into a single `entry`
-- aggregate (one record per row; see the client's HealthEntry model + the
-- Dexie v3 upgrade). Pre-launch coordinated ship: no backward-compat with the
-- old aggregate names.
--
-- Only `sync_changes_plain` still carries an `aggregate` column with a CHECK
-- constraint — `sync_changes_encrypted` dropped its `aggregate`/`op` columns in
-- 20260528010000_strip_encrypted_metadata.sql (the aggregate now travels inside
-- the encrypted envelope), so there is nothing to alter there.

alter table public.sync_changes_plain
  drop constraint if exists sync_changes_plain_aggregate_check;

alter table public.sync_changes_plain
  add constraint sync_changes_plain_aggregate_check
  check (aggregate in ('entry', 'prescription', 'profile'));

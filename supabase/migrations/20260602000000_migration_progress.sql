-- Live progress for an in-flight E2EE migration.
--
-- The device driving a migration heartbeats `migration_updated_at` together
-- with these two counts as it encrypts records. Other devices read them to
-- render a progress bar / percentage and — by watching how recently
-- `migration_updated_at` advanced — to tell an actively-running migration from
-- a stalled one (so they only offer to "take over" when it looks stuck).
--
-- Plain counts (no record content), so they carry no privacy weight even on an
-- E2EE account. Nullable: absent until the owning device reports the first tick.
alter table public.sync_accounts
  add column if not exists migration_records_total integer,
  add column if not exists migration_records_converted integer;

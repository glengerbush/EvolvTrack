-- `inserted_at` is the incremental-pull high-water mark for sync clients. The
-- sync tables keep one current row per (user_id, id), so subsequent pushes use
-- ON CONFLICT DO UPDATE rather than inserting a new event. A column default is
-- only applied on INSERT; without this trigger an update keeps its original
-- `inserted_at` and devices whose cursor passed that value never fetch it.
--
-- Keep the existing column name for backwards compatibility, but make its
-- actual contract explicit: it is a server-owned "last changed at" cursor.

create or replace function private.refresh_sync_change_cursor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.inserted_at := clock_timestamp();
  return new;
end;
$$;

-- Trigger functions are invoked by Postgres, not called through the Data API.
-- Keep direct execution unavailable even if the private schema is exposed by
-- mistake in a future configuration change.
revoke all on function private.refresh_sync_change_cursor() from public, anon, authenticated;

drop trigger if exists refresh_sync_change_cursor
  on public.sync_changes_plain;
create trigger refresh_sync_change_cursor
before insert or update on public.sync_changes_plain
for each row execute function private.refresh_sync_change_cursor();

drop trigger if exists refresh_sync_change_cursor
  on public.sync_changes_encrypted;
create trigger refresh_sync_change_cursor
before insert or update on public.sync_changes_encrypted
for each row execute function private.refresh_sync_change_cursor();

-- Force one catch-up pull after deployment. Rows updated before this migration
-- may already have been skipped by another device, so merely fixing future
-- updates would leave those devices stale until the same entity changed again.
update public.sync_changes_plain
set inserted_at = clock_timestamp();

update public.sync_changes_encrypted
set inserted_at = clock_timestamp();

-- Incremental pulls constrain by user_id and range/order by inserted_at.
create index if not exists sync_changes_plain_user_inserted_at_idx
  on public.sync_changes_plain (user_id, inserted_at);

create index if not exists sync_changes_encrypted_user_inserted_at_idx
  on public.sync_changes_encrypted (user_id, inserted_at);

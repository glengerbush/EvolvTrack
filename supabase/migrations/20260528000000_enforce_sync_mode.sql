-- Enforce that writes to the sync change tables match the account's sync_mode.
--
-- Defense in depth against a client whose local view of sync_mode has drifted
-- from the server's. The critical case is privacy: a fresh device that signs
-- in to an E2EE account but boots with a default `plain` profile would
-- otherwise be able to push plaintext records to sync_changes_plain, bypassing
-- end-to-end encryption entirely. With this guard in place, such a write is
-- rejected at the row-security boundary regardless of client logic.
--
-- Rules:
--   sync_changes_plain     INSERT/UPDATE allowed when sync_accounts has no
--                          row (brand-new account) OR sync_mode ∈
--                          {plain, migrating_to_plain}.
--   sync_changes_encrypted INSERT/UPDATE allowed when sync_mode ∈
--                          {e2ee, migrating_to_e2ee, rotating_e2ee_key}.
--                          A row in sync_accounts is required: encrypted
--                          writes presuppose the account has been promoted
--                          out of the default plain mode.
--
-- DELETE and SELECT are unchanged: an account in transition needs to read
-- its existing rows and tombstone them as part of the migration.

create or replace function public.sync_mode_allows_plain(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select sync_mode in ('plain', 'migrating_to_plain')
       from public.sync_accounts where user_id = p_uid),
    true
  );
$$;

create or replace function public.sync_mode_allows_encrypted(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select sync_mode in ('e2ee', 'migrating_to_e2ee', 'rotating_e2ee_key')
       from public.sync_accounts where user_id = p_uid),
    false
  );
$$;

grant execute on function public.sync_mode_allows_plain(uuid) to authenticated, service_role;
grant execute on function public.sync_mode_allows_encrypted(uuid) to authenticated, service_role;

-- Re-create the insert/update policies on sync_changes_plain with the
-- additional sync_mode check.
drop policy if exists "Users can create their plain changes" on public.sync_changes_plain;
drop policy if exists "Users can update their plain changes" on public.sync_changes_plain;

create policy "Users can create their plain changes"
  on public.sync_changes_plain
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
    and public.sync_mode_allows_plain((select auth.uid()))
  );

create policy "Users can update their plain changes"
  on public.sync_changes_plain
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
    and public.sync_mode_allows_plain((select auth.uid()))
  );

-- Symmetric guard on sync_changes_encrypted: only allow writes once the
-- account has actually transitioned out of plain mode.
drop policy if exists "Users can create their encrypted changes" on public.sync_changes_encrypted;
drop policy if exists "Users can update their encrypted changes" on public.sync_changes_encrypted;

create policy "Users can create their encrypted changes"
  on public.sync_changes_encrypted
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
    and public.sync_mode_allows_encrypted((select auth.uid()))
  );

create policy "Users can update their encrypted changes"
  on public.sync_changes_encrypted
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and public.has_active_license((select auth.uid()))
    and public.sync_mode_allows_encrypted((select auth.uid()))
  );

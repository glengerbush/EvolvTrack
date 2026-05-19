-- Tighten table grants and document RLS deny-all on sensitive tables.
--
-- Addresses Supabase pg_lint advisories raised against the initial schema:
--   * 0026 pg_graphql_anon_table_exposed   — all 5 public tables
--   * 0027 pg_graphql_authenticated_table_exposed — app_admins, licenses
--   * 0028 anon_security_definer_function_executable — has_active_license
--   * 0008 rls_enabled_no_policy           — app_admins, licenses
--
-- Knowingly NOT addressed (left with explanatory comments below):
--   * 0027 on sync_accounts, sync_changes_encrypted, sync_changes_plain —
--     authenticated callers must SELECT these for sync to function; RLS in
--     section 4 of the initial migration gates rows to `auth.uid() = user_id`.
--   * 0029 on the license + admin RPCs — all guard internally with
--     auth.uid() or private.is_admin(auth.uid()); the lint can't see the
--     function bodies. Moving them out of `public` would break the client
--     (src/lib/sync/license.ts calls them via supabase.rpc()).

------------------------------------------------------------------------------
-- 1. Revoke unnecessary table grants.
--
-- Supabase's default privileges grant SELECT/INSERT/UPDATE/DELETE on public
-- tables to both `anon` and `authenticated`. None of these tables should be
-- discoverable without a session, so revoke from anon across the board.
-- For app_admins and licenses, also revoke from authenticated — the only
-- supported access path is the SECURITY DEFINER RPCs.
------------------------------------------------------------------------------

revoke all on table public.sync_accounts            from anon;
revoke all on table public.sync_changes_encrypted   from anon;
revoke all on table public.sync_changes_plain       from anon;
revoke all on table public.app_admins               from anon, authenticated;
revoke all on table public.licenses                 from anon, authenticated;

------------------------------------------------------------------------------
-- 2. has_active_license: revoke the implicit PUBLIC execute.
--
-- The initial migration grants execute to authenticated + service_role but
-- never revokes from PUBLIC, so anon callers can probe any uuid via
-- /rest/v1/rpc/has_active_license. The function is only meant to be used
-- internally by RLS policies and by signed-in users checking their own
-- status — lock it down accordingly.
------------------------------------------------------------------------------

revoke execute on function public.has_active_license(uuid) from public, anon;

------------------------------------------------------------------------------
-- 3. Documenting RLS policies on the locked-down tables.
--
-- `app_admins` and `licenses` have RLS enabled but no policies, which is the
-- intended deny-all (all access flows through SECURITY DEFINER RPCs). The
-- pg_lint advisory 0008 can't tell that's intentional, so we add explicit
-- restrictive policies that document the design and silence the warning.
-- Restrictive `using (false)` denies every direct row to every role, on top
-- of the table-level revokes above.
------------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_admins'
  ) then
    create policy "Deny direct access; use admin_* RPCs"
      on public.app_admins
      as restrictive
      for all
      to public
      using (false)
      with check (false);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'licenses'
  ) then
    create policy "Deny direct access; use license_status / admin_* RPCs"
      on public.licenses
      as restrictive
      for all
      to public
      using (false)
      with check (false);
  end if;
end $$;

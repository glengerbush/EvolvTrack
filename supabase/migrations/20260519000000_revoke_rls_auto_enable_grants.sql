-- Lock down public.rls_auto_enable() to event-trigger use only.
--
-- This function is provided by Supabase as the body of an event trigger
-- (typically `enable_rls_on_new_tables` on `ddl_command_end`) that
-- auto-enables RLS on every new table created in the `public` schema. The
-- default ACL grants EXECUTE to anon / authenticated / service_role, which
-- the database advisor flags via lint 0028 (anon SECURITY DEFINER) and 0029
-- (authenticated SECURITY DEFINER).
--
-- In practice the function is not reachable as an RPC: PostgREST does not
-- expose functions whose return type is the `event_trigger` pseudo-type, and
-- even if the body were invoked directly its first call to
-- pg_event_trigger_ddl_commands() raises an error when not running inside an
-- event trigger. The only side effect the body can ever produce is
-- `alter table ... enable row level security`, which strengthens — never
-- weakens — security. So this revoke is hygiene and lint-silencing, not a
-- vulnerability fix.
--
-- service_role's grant is left in place: Supabase's own admin tooling may
-- rely on it.
--
-- The function is only present on hosted Supabase projects, not in the local
-- `supabase start` stack, so guard the revoke with a pg_proc lookup to keep
-- the migration idempotent and environment-agnostic.

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- Self-service account deletion.
--
-- Deletes the calling user's auth.users row. Foreign-key cascades take care
-- of every dependent table:
--   * public.sync_accounts            (on delete cascade)
--   * public.sync_changes_encrypted   (on delete cascade)
--   * public.sync_changes_plain       (on delete cascade)
--   * public.app_admins               (on delete cascade)
--
-- public.licenses.claimed_by_user_id is `on delete set null`, so any license
-- the user had claimed is returned to the unclaimed pool. The code itself
-- is HMAC-hashed and unrecoverable, so in practice the user loses access to
-- that license — admins can re-issue via admin_generate_licenses if needed.

create or replace function public.delete_self()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  delete from auth.users where id = v_uid;
end;
$$;

revoke execute on function public.delete_self() from public, anon;
grant execute on function public.delete_self() to authenticated;

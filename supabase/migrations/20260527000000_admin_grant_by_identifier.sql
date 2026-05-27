-- Resolve a username / email / UUID and grant admin in one call. Mirrors the
-- client-side normalization in src/lib/auth/supabase.ts so username-only
-- accounts (stored under <slug>@users.evolvtrack.com) can be granted by their
-- bare username.

create or replace function public.admin_grant_admin_by_identifier(p_identifier text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_identifier text;
  v_email      text;
  v_normalized text;
  v_user_id    uuid;
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'not_admin';
  end if;

  v_identifier := lower(btrim(coalesce(p_identifier, '')));
  if v_identifier = '' then
    raise exception 'invalid_identifier';
  end if;

  if v_identifier ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_user_id := v_identifier::uuid;
    if not exists (select 1 from auth.users where id = v_user_id) then
      raise exception 'user_not_found';
    end if;
  else
    if position('@' in v_identifier) > 0 then
      v_email := v_identifier;
    else
      v_normalized := regexp_replace(v_identifier, '[^a-z0-9]+', '-', 'g');
      v_normalized := regexp_replace(v_normalized, '^-+|-+$', '', 'g');
      if v_normalized = '' then v_normalized := 'user'; end if;
      v_email := v_normalized || '@users.evolvtrack.com';
    end if;

    select id into v_user_id
      from auth.users
      where lower(email) = v_email
      limit 1;

    if v_user_id is null then
      raise exception 'user_not_found';
    end if;
  end if;

  insert into public.app_admins (user_id) values (v_user_id)
    on conflict (user_id) do nothing;

  return v_user_id;
end;
$$;

revoke execute on function public.admin_grant_admin_by_identifier(text) from public, anon;
grant  execute on function public.admin_grant_admin_by_identifier(text) to authenticated;

-- Close the crash gap between server account deletion and local Device Data Erasure.
-- A random request id is durably prepared on the device before this RPC. The
-- retained receipt lets a restarted client prove server success before erasing.

create table if not exists public.account_deletion_receipts (
  request_id uuid primary key,
  deleted_at timestamptz not null default now()
);

alter table public.account_deletion_receipts enable row level security;
revoke all on table public.account_deletion_receipts from public, anon, authenticated;

drop function if exists public.delete_self();

create or replace function public.delete_self(p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if exists (
    select 1 from public.account_deletion_receipts where request_id = p_request_id
  ) then
    return p_request_id;
  end if;

  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.account_deletion_receipts(request_id) values (p_request_id);
  delete from auth.users where id = v_uid;
  return p_request_id;
end;
$$;

create or replace function public.account_deletion_confirmed(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.account_deletion_receipts where request_id = p_request_id
  );
$$;

revoke execute on function public.delete_self(uuid) from public, anon;
grant execute on function public.delete_self(uuid) to authenticated;
revoke execute on function public.account_deletion_confirmed(uuid) from public;
grant execute on function public.account_deletion_confirmed(uuid) to anon, authenticated;

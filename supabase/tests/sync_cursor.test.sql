begin;

create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email)
values ('40000000-0000-0000-0000-000000000004', 'sync-cursor@example.com');

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.sync_changes_plain'::regclass
      and tgname = 'refresh_sync_change_cursor'
      and not tgisinternal
  ),
  'plaintext changes refresh their pull cursor on every write'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.sync_changes_encrypted'::regclass
      and tgname = 'refresh_sync_change_cursor'
      and not tgisinternal
  ),
  'encrypted changes refresh their pull cursor on every write'
);

select ok(
  to_regclass('public.sync_changes_plain_user_inserted_at_idx') is not null,
  'plaintext incremental pulls have a matching index'
);

select ok(
  to_regclass('public.sync_changes_encrypted_user_inserted_at_idx') is not null,
  'encrypted incremental pulls have a matching index'
);

insert into public.sync_changes_plain (
  id,
  user_id,
  aggregate,
  op,
  payload,
  protocol_version,
  schema_version,
  created_at
)
values (
  'entry:cursor-plain',
  '40000000-0000-0000-0000-000000000004',
  'entry',
  'upsert',
  '{"aggregate":"entry","op":"upsert","record":{"id":"cursor-plain","weightLbs":180}}',
  1,
  1,
  '2026-08-03T12:00:00Z'
);

create temporary table plain_cursor_before as
select inserted_at
from public.sync_changes_plain
where user_id = '40000000-0000-0000-0000-000000000004'
  and id = 'entry:cursor-plain';

do $$ begin perform pg_sleep(0.01); end $$;

insert into public.sync_changes_plain (
  id,
  user_id,
  aggregate,
  op,
  payload,
  protocol_version,
  schema_version,
  created_at
)
values (
  'entry:cursor-plain',
  '40000000-0000-0000-0000-000000000004',
  'entry',
  'upsert',
  '{"aggregate":"entry","op":"upsert","record":{"id":"cursor-plain","weightLbs":175}}',
  1,
  1,
  '2026-08-03T12:01:00Z'
)
on conflict (user_id, id) do update
set
  payload = excluded.payload,
  created_at = excluded.created_at;

select is(
  (
    select count(*)
    from public.sync_changes_plain
    where user_id = '40000000-0000-0000-0000-000000000004'
      and inserted_at > (select inserted_at from plain_cursor_before)
  ),
  1::bigint,
  'an update to an existing plaintext row is visible after the old cursor'
);

insert into public.sync_changes_encrypted (
  id,
  user_id,
  ciphertext,
  iv,
  protocol_version,
  encryption_version,
  dek_version,
  schema_version,
  created_at
)
values (
  'entry:cursor-encrypted',
  '40000000-0000-0000-0000-000000000004',
  'ciphertext-v1',
  'iv-v1',
  1,
  1,
  1,
  1,
  '2026-08-03T12:00:00Z'
);

create temporary table encrypted_cursor_before as
select inserted_at
from public.sync_changes_encrypted
where user_id = '40000000-0000-0000-0000-000000000004'
  and id = 'entry:cursor-encrypted';

do $$ begin perform pg_sleep(0.01); end $$;

insert into public.sync_changes_encrypted (
  id,
  user_id,
  ciphertext,
  iv,
  protocol_version,
  encryption_version,
  dek_version,
  schema_version,
  created_at
)
values (
  'entry:cursor-encrypted',
  '40000000-0000-0000-0000-000000000004',
  'ciphertext-v2',
  'iv-v2',
  1,
  1,
  1,
  1,
  '2026-08-03T12:01:00Z'
)
on conflict (user_id, id) do update
set
  ciphertext = excluded.ciphertext,
  iv = excluded.iv,
  created_at = excluded.created_at;

select is(
  (
    select count(*)
    from public.sync_changes_encrypted
    where user_id = '40000000-0000-0000-0000-000000000004'
      and inserted_at > (select inserted_at from encrypted_cursor_before)
  ),
  1::bigint,
  'an update to an existing encrypted row is visible after the old cursor'
);

select * from finish();
rollback;

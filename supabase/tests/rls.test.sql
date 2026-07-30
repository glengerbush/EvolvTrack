begin;

create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (id, email)
values
  ('10000000-0000-0000-0000-000000000001', 'rls-user-1@example.com'),
  ('20000000-0000-0000-0000-000000000002', 'rls-user-2@example.com'),
  ('30000000-0000-0000-0000-000000000003', 'rls-user-3@example.com');

insert into public.sync_accounts (user_id, sync_mode)
values
  ('10000000-0000-0000-0000-000000000001', 'plain'),
  ('20000000-0000-0000-0000-000000000002', 'e2ee');

insert into public.wrapped_keys (
  user_id,
  dek_version,
  passphrase_salt_b64,
  passphrase_wrapped_ciphertext,
  passphrase_wrapped_iv,
  recovery_salt_b64,
  recovery_wrapped_ciphertext,
  recovery_wrapped_iv
)
values
  (
    '10000000-0000-0000-0000-000000000001',
    1, 'salt-1', 'cipher-1', 'iv-1', 'recovery-salt-1', 'recovery-cipher-1', 'recovery-iv-1'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    1, 'salt-2', 'cipher-2', 'iv-2', 'recovery-salt-2', 'recovery-cipher-2', 'recovery-iv-2'
  );

insert into public.licenses (
  code_hmac,
  code_prefix,
  tier,
  status,
  claimed_by_user_id,
  claimed_at
)
values (
  'rls-test-license-hmac',
  'EVOLV-RLS',
  'lifetime',
  'active',
  '20000000-0000-0000-0000-000000000002',
  now()
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  auth.uid(),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'the test JWT resolves to user 1'
);
select is(
  (select count(*) from public.sync_accounts),
  1::bigint,
  'RLS exposes only the current sync account'
);
select is(
  (select count(*) from public.wrapped_keys),
  1::bigint,
  'RLS exposes only the current wrapped key'
);
select ok(
  public.sync_mode_allows_plain('10000000-0000-0000-0000-000000000001'),
  'the current user can check their own allowed sync mode'
);
select is(
  public.sync_mode_allows_plain('20000000-0000-0000-0000-000000000002'),
  false,
  'sync-mode helpers do not disclose another user mode'
);
select is(
  public.sync_mode_allows_encrypted('20000000-0000-0000-0000-000000000002'),
  false,
  'encrypted-mode helper also rejects cross-user probes'
);
select is(
  public.has_active_license('20000000-0000-0000-0000-000000000002'),
  false,
  'license helper does not disclose another user entitlement'
);
select is(
  public.has_active_license('10000000-0000-0000-0000-000000000001'),
  false,
  'the current unlicensed user receives their own result'
);
select results_eq(
  $$
    update public.sync_accounts
    set updated_at = now()
    where user_id = '20000000-0000-0000-0000-000000000002'
    returning user_id
  $$,
  $$ values (null::uuid) limit 0 $$,
  'cross-user updates affect no rows'
);
select throws_ok(
  $$
    insert into public.sync_accounts (user_id, sync_mode)
    values ('30000000-0000-0000-0000-000000000003', 'plain')
  $$,
  '42501',
  'new row violates row-level security policy for table "sync_accounts"',
  'cross-user inserts are rejected'
);
select lives_ok(
  $$
    update public.sync_accounts
    set updated_at = now()
    where user_id = '10000000-0000-0000-0000-000000000001'
  $$,
  'own-row updates are allowed'
);
select throws_ok(
  'select * from public.licenses',
  '42501',
  'permission denied for table licenses',
  'license rows cannot be read directly'
);
select is(
  has_schema_privilege(current_user, 'private', 'usage'),
  false,
  'authenticated users cannot access the private schema'
);
select is(public.am_i_admin(), false, 'ordinary users are not administrators');
select throws_ok(
  'select * from public.admin_list_admins()',
  'P0001',
  'not_admin',
  'admin RPCs reject ordinary authenticated users'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  'select * from public.sync_accounts',
  '42501',
  'permission denied for table sync_accounts',
  'anonymous callers cannot read sync tables'
);

reset role;
select * from finish();
rollback;

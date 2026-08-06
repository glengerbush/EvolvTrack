begin;

create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email)
values
  ('41000000-0000-0000-0000-000000000001', 'lifecycle-1@example.com'),
  ('42000000-0000-0000-0000-000000000002', 'lifecycle-2@example.com');

insert into public.sync_accounts (
  user_id,
  sync_mode,
  e2ee_migration_id,
  e2ee_migration_direction,
  migration_owner_device_id,
  migration_started_at,
  migration_updated_at,
  e2ee_transition_phase,
  active_dek_version
)
values
  (
    '41000000-0000-0000-0000-000000000001',
    'migrating_to_plain', 'migration-1', 'disable', 'device-1', now(), now(), 'transferring', 1
  ),
  (
    '42000000-0000-0000-0000-000000000002',
    'migrating_to_e2ee', 'migration-2', 'enable', 'device-2', now(), now(), 'preparing', null
  );

insert into public.sync_changes_plain (
  id, user_id, aggregate, op, payload, protocol_version, schema_version, created_at
)
values
  ('entry:one', '41000000-0000-0000-0000-000000000001', 'entry', 'upsert', '{}', 1, 1, now()),
  ('entry:two', '42000000-0000-0000-0000-000000000002', 'entry', 'upsert', '{}', 1, 1, now());

insert into public.sync_changes_encrypted (
  id, user_id, ciphertext, iv, protocol_version, encryption_version, schema_version, created_at, dek_version
)
values
  ('entry:one', '41000000-0000-0000-0000-000000000001', 'cipher-1', 'iv-1', 1, 1, 1, now(), 1),
  ('entry:two', '42000000-0000-0000-0000-000000000002', 'cipher-2', 'iv-2', 1, 1, 1, now(), 1);

insert into public.wrapped_keys (
  user_id, dek_version,
  passphrase_salt_b64, passphrase_wrapped_ciphertext, passphrase_wrapped_iv,
  passphrase_iterations,
  recovery_salt_b64, recovery_wrapped_ciphertext, recovery_wrapped_iv,
  recovery_iterations, recovery_status
)
values
  (
    '41000000-0000-0000-0000-000000000001', 1,
    'ps-1', 'pc-1', 'pi-1', 600000,
    'rs-1', 'rc-1', 'ri-1', 600000, 'confirmed'
  ),
  (
    '42000000-0000-0000-0000-000000000002', 1,
    'ps-2', 'pc-2', 'pi-2', 600000,
    'rs-2', 'rc-2', 'ri-2', 600000, 'confirmed'
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select lives_ok(
  $$ select public.advance_sync_transition_phase('migration-1', 'device-1', 'verifying') $$,
  'the owner can advance transition phase'
);
select is(
  (select e2ee_transition_phase from public.sync_accounts where user_id = auth.uid()),
  'verifying',
  'transition phase is durable'
);
select throws_ok(
  $$ select public.advance_sync_transition_phase('migration-1', 'device-1', 'transferring') $$,
  'P0001',
  'transition_phase_regression',
  'transition phase cannot move backward'
);
select throws_ok(
  $$ select public.advance_sync_transition_phase('migration-1', 'wrong-device', 'finalizing') $$,
  'P0001',
  'sync_transition_conflict',
  'a non-owner cannot advance transition phase'
);

select throws_ok(
  $$ select public.start_fresh_sync('migration-1', 'wrong-device') $$,
  'P0001',
  'sync_transition_conflict',
  'Start Fresh rejects a non-owner'
);
select is((select count(*) from public.sync_changes_plain), 1::bigint, 'failed Start Fresh preserves plaintext');
select is((select count(*) from public.sync_changes_encrypted), 1::bigint, 'failed Start Fresh preserves ciphertext');

select lives_ok(
  $$ select public.start_fresh_sync('migration-1', 'device-1') $$,
  'the owner can atomically Start Fresh'
);
select is((select count(*) from public.sync_changes_plain), 0::bigint, 'Start Fresh deletes own plaintext');
select is((select count(*) from public.sync_changes_encrypted), 0::bigint, 'Start Fresh deletes own ciphertext');
select is((select count(*) from public.wrapped_keys), 0::bigint, 'Start Fresh deletes own wrapped keys');
select is(
  (select sync_mode from public.sync_accounts where user_id = auth.uid()),
  'plain',
  'Start Fresh finalizes plain mode'
);
select is(
  (select e2ee_transition_phase from public.sync_accounts where user_id = auth.uid()),
  null,
  'Start Fresh clears transition phase'
);

reset role;
select is(
  (select count(*) from public.sync_changes_plain where user_id = '42000000-0000-0000-0000-000000000002'),
  1::bigint,
  'Start Fresh does not delete another account'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"42000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select lives_ok(
  $$ select public.abandon_sync_transition('migration-2', 'device-2') $$,
  'the owner can abandon a prepared transition'
);
select is(
  (select sync_mode from public.sync_accounts where user_id = auth.uid()),
  'plain',
  'abandonment restores the source mode'
);
reset role;

select lives_ok(
  $$
    insert into public.wrapped_keys (
      user_id, dek_version,
      passphrase_salt_b64, passphrase_wrapped_ciphertext, passphrase_wrapped_iv,
      passphrase_iterations, recovery_status
    ) values (
      '41000000-0000-0000-0000-000000000001', 2,
      'ps-3', 'pc-3', 'pi-3', 600000, 'declined'
    )
  $$,
  'a declined recovery code has no recovery wrapping'
);

select * from finish();
rollback;

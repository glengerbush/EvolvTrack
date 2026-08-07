import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { db } from '$lib/db/schema';
import {
  addEntry,
  addPrescription,
  applyRemoteChange,
  deleteEntry,
  deletePrescription,
  getProfile,
  onOutboxChange,
  saveProfile,
  setLocalProfileSyncState,
  updateEntry,
  updatePrescription,
} from '$lib/domain/health-data-storage';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TODAY = iso('2026-05-10');

describe('Health Data Storage outgoing Weigh-in changes', () => {
  it('addEntry enqueues an upsert keyed by aggregate:id with the full record', async () => {
    const created = await addEntry({ date: TODAY, weightLbs: 180 });

    const entry = await db.outbox.get(`entry:${created.id}`);
    expect(entry).toMatchObject({
      id: `entry:${created.id}`,
      aggregate: 'entry',
      entityId: created.id,
      op: 'upsert',
      updatedAt: created.updatedAt,
    });
    expect(entry!.payload).toMatchObject({ id: created.id, weightLbs: 180 });
  });

  it('updateEntry coalesces onto the same row with the updated payload', async () => {
    const created = await addEntry({ date: TODAY, weightLbs: 180 });
    await updateEntry(created.id, { weightLbs: 178 });

    expect(await db.outbox.count()).toBe(1);
    const entry = await db.outbox.get(`entry:${created.id}`);
    expect(entry!.op).toBe('upsert');
    expect(entry!.payload).toMatchObject({ id: created.id, weightLbs: 178 });
    expect((entry!.payload as { updatedAt: string }).updatedAt).toBe(entry!.updatedAt);
  });

  it('deleteEntry replaces the row with a delete tombstone (null payload)', async () => {
    const created = await addEntry({ date: TODAY, weightLbs: 180 });
    await deleteEntry(created.id);

    expect(await db.outbox.count()).toBe(1);
    const entry = await db.outbox.get(`entry:${created.id}`);
    expect(entry).toMatchObject({ op: 'delete', entityId: created.id, payload: null });
  });

  it('deleteEntry against an unknown id does not enqueue a tombstone', async () => {
    await deleteEntry('does-not-exist');
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('outbox capture — injections', () => {
  it('add, update, then delete coalesce into a single delete row', async () => {
    const created = await addEntry({
      date: TODAY,
      amountMg: 5,
      medication: SEMA,
      site: '',
      symptoms: [],
    });
    await updateEntry(created.id, { amountMg: 7 });
    await deleteEntry(created.id);

    expect(await db.outbox.count()).toBe(1);
    const entry = await db.outbox.get(`entry:${created.id}`);
    expect(entry).toMatchObject({ aggregate: 'entry', op: 'delete', payload: null });
  });

  it('updateEntry enqueues the post-update record', async () => {
    const created = await addEntry({
      date: TODAY,
      amountMg: 5,
      medication: SEMA,
      site: '',
      symptoms: [],
    });
    await updateEntry(created.id, { amountMg: 7 });

    const entry = await db.outbox.get(`entry:${created.id}`);
    expect(entry!.payload).toMatchObject({ id: created.id, amountMg: 7 });
  });
});

describe('outbox capture — prescriptions', () => {
  it('addPrescription enqueues an upsert with the stored record', async () => {
    const created = await addPrescription({ type: SEMA, dosesLeft: 4 });

    const entry = await db.outbox.get(`prescription:${created.id}`);
    expect(entry).toMatchObject({ aggregate: 'prescription', op: 'upsert' });
    expect(entry!.payload).toMatchObject({ id: created.id, type: SEMA, dosesLeft: 4 });
  });

  it('updatePrescription against an unknown id does not enqueue', async () => {
    await updatePrescription('does-not-exist', { dosesLeft: 1 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('deletePrescription enqueues a delete tombstone', async () => {
    const created = await addPrescription({ type: SEMA });
    await deletePrescription(created.id);

    const entry = await db.outbox.get(`prescription:${created.id}`);
    expect(entry).toMatchObject({ op: 'delete', payload: null });
  });
});

describe('outbox capture — profile', () => {
  it('saveProfile enqueues a profile:profile upsert with device-local sync state stripped', async () => {
    await saveProfile({
      startWeight: 200,
      goalWeight: 170,
      syncMode: 'e2ee',
      passphraseEnabled: true,
    });

    const entry = await db.outbox.get('profile:profile');
    expect(entry).toMatchObject({ aggregate: 'profile', entityId: 'profile', op: 'upsert' });

    const payload = entry!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ id: 'profile', startWeight: 200, goalWeight: 170 });
    // syncMode + e2eeMigration are device-local and must not be synced;
    // passphraseEnabled is forced false on the synced copy.
    expect(payload.syncMode).toBeUndefined();
    expect(payload.e2eeMigration).toBeUndefined();
    expect(payload.passphraseEnabled).toBe(false);
  });

  it('a second saveProfile coalesces onto the same single row', async () => {
    await saveProfile({ startWeight: 200 });
    await saveProfile({ goalWeight: 165 });

    expect(await db.outbox.count()).toBe(1);
    const entry = await db.outbox.get('profile:profile');
    expect(entry!.payload).toMatchObject({ startWeight: 200, goalWeight: 165 });
  });
});

describe('setLocalProfileSyncState — device-local writer', () => {
  it('creates a profile stub with the supplied mode and does NOT enqueue an outbox row', async () => {
    await setLocalProfileSyncState({ syncMode: 'e2ee', passphraseEnabled: true });

    const profile = await getProfile();
    expect(profile).toMatchObject({
      id: 'profile',
      syncMode: 'e2ee',
      passphraseEnabled: true,
    });
    // Device-local writes must not push: a profile-aggregate outbox row here
    // would be a wasted round-trip (toSyncableProfile strips these fields).
    expect(await db.outbox.count()).toBe(0);
  });

  it('updates an existing profile without enqueueing or touching syncable fields', async () => {
    await saveProfile({ startWeight: 200 });
    const beforeCount = await db.outbox.count();
    expect(beforeCount).toBe(1);

    await setLocalProfileSyncState({ syncMode: 'e2ee', passphraseEnabled: true });

    const profile = await getProfile();
    expect(profile).toMatchObject({
      startWeight: 200,
      syncMode: 'e2ee',
      passphraseEnabled: true,
    });
    // No new outbox entry beyond the original saveProfile one.
    expect(await db.outbox.count()).toBe(beforeCount);
  });
});

describe('onOutboxChange', () => {
  it('fires when a local mutation enqueues an outbox entry', async () => {
    let calls = 0;
    const off = onOutboxChange(() => {
      calls += 1;
    });
    try {
      await addEntry({ date: TODAY, weightLbs: 180 });
      expect(calls).toBe(1);
    } finally {
      off();
    }
  });

  it('does NOT fire for an applied remote change (no sync loop)', async () => {
    let calls = 0;
    const off = onOutboxChange(() => {
      calls += 1;
    });
    try {
      await applyRemoteChange({
        aggregate: 'entry',
        entityId: 'remote-1',
        op: 'upsert',
        record: {
          id: 'remote-1',
          date: TODAY,
          weightLbs: 170,
          symptoms: [],
          createdAt: '2026-05-10T00:00:00.000Z',
          updatedAt: '2026-05-10T00:00:00.000Z',
        },
        remoteUpdatedAt: '2026-05-10T00:00:00.000Z',
      });
      expect(calls).toBe(0);
    } finally {
      off();
    }
  });

  it('stops firing after the listener unsubscribes', async () => {
    let calls = 0;
    const off = onOutboxChange(() => {
      calls += 1;
    });
    await addEntry({ date: TODAY, weightLbs: 180 });
    off();
    await addEntry({ date: TODAY, weightLbs: 181 });
    expect(calls).toBe(1);
  });
});

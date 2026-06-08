import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { db } from '$lib/db/schema';
import {
  DEFAULT_SYNC_MODE,
  MigrationInProgressError,
  addEntry,
  addPrescription,
  applyRemoteChange,
  clearAllData,
  deletePrescription,
  getAllEntries,
  getAllPrescriptions,
  getProfile,
  getProfileSyncMode,
  saveProfile,
  setLocalProfileSyncState,
  sortPrescriptionsByDisplayOrder,
  updatePrescription,
} from '$lib/domain/repo';
import type { Prescription, ProfileSettings } from '$lib/domain/types';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)' as const;
const TODAY = iso('2026-05-10');

function prescriptionFixture(overrides: Partial<Prescription>): Prescription {
  return {
    id: 'p-fixture',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('addPrescription', () => {
  it('persists a new prescription with generated id, createdAt/updatedAt, and assigns sortOrder 0 when none exist', async () => {
    const created = await addPrescription({
      type: SEMA,
      concentrationMgMl: 5,
      vialMl: 2,
      prescribedDoseMg: 2.5,
    });

    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBe(created.updatedAt);
    expect(created.sortOrder).toBe(0);

    const stored = await db.prescriptions.get(created.id);
    expect(stored).toMatchObject({
      id: created.id,
      type: SEMA,
      concentrationMgMl: 5,
      sortOrder: 0,
    });
  });

  it('assigns incrementing sortOrder = max + 1 when previous prescriptions have sortOrder', async () => {
    const first = await addPrescription({ type: SEMA });
    const second = await addPrescription({ type: SEMA });
    const third = await addPrescription({ type: TIRZ });

    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    expect(third.sortOrder).toBe(2);
  });

  it('honors a caller-supplied sortOrder over the auto-assignment', async () => {
    await addPrescription({ type: SEMA });
    const created = await addPrescription({ type: TIRZ, sortOrder: 99 });
    expect(created.sortOrder).toBe(99);
  });

  it('falls back to prescriptions.length when stored rows lack a numeric sortOrder', async () => {
    // Insert a row directly with no sortOrder to exercise the fallback branch.
    await db.prescriptions.put(
      prescriptionFixture({ id: 'legacy', type: SEMA, sortOrder: undefined }),
    );
    const created = await addPrescription({ type: TIRZ });
    expect(created.sortOrder).toBe(1);
  });
});

describe('updatePrescription', () => {
  it('patches fields and bumps updatedAt while preserving createdAt and id', async () => {
    const created = await addPrescription({ type: SEMA, dosesLeft: 4 });
    const originalCreatedAt = created.createdAt;

    // Wait at least one tick so updatedAt is different (Date.now() can otherwise
    // collide). Use a microtask delay; the assertion is "not earlier".
    await new Promise((r) => setTimeout(r, 2));
    await updatePrescription(created.id, { dosesLeft: 2, pharmacy: 'Greenwich' });

    const after = await db.prescriptions.get(created.id);
    expect(after).toMatchObject({
      id: created.id,
      type: SEMA,
      dosesLeft: 2,
      pharmacy: 'Greenwich',
      createdAt: originalCreatedAt,
    });
    expect(after!.updatedAt >= originalCreatedAt).toBe(true);
  });

  it('is a no-op against an unknown id (does not insert)', async () => {
    await updatePrescription('does-not-exist', { dosesLeft: 1 });
    expect(await db.prescriptions.toArray()).toHaveLength(0);
  });
});

describe('deletePrescription', () => {
  it('removes the matching prescription and leaves siblings intact', async () => {
    const a = await addPrescription({ type: SEMA });
    const b = await addPrescription({ type: TIRZ });

    await deletePrescription(a.id);

    const all = await db.prescriptions.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(b.id);
  });

  it('silently succeeds when deleting an unknown id', async () => {
    await expect(deletePrescription('ghost')).resolves.toBeUndefined();
  });
});

describe('getAllPrescriptions', () => {
  it('returns prescriptions sorted by sortOrder when all rows have it', async () => {
    const a = await addPrescription({ type: SEMA, sortOrder: 2 });
    const b = await addPrescription({ type: TIRZ, sortOrder: 0 });
    const c = await addPrescription({ type: SEMA, sortOrder: 1 });

    const list = await getAllPrescriptions();
    expect(list.map((p) => p.id)).toEqual([b.id, c.id, a.id]);
  });

  it('falls back to createdAt-then-id ordering when any row is missing sortOrder', async () => {
    // Insert legacy rows directly with no sortOrder to force the fallback path.
    await db.prescriptions.put(
      prescriptionFixture({
        id: 'p-late',
        type: SEMA,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
        sortOrder: undefined,
      }),
    );
    await db.prescriptions.put(
      prescriptionFixture({
        id: 'p-early',
        type: TIRZ,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sortOrder: undefined,
      }),
    );

    const list = await getAllPrescriptions();
    expect(list.map((p) => p.id)).toEqual(['p-early', 'p-late']);
  });

  it('returns an empty array when the table is empty', async () => {
    expect(await getAllPrescriptions()).toEqual([]);
  });
});

describe('sortPrescriptionsByDisplayOrder', () => {
  it('does not mutate its input', () => {
    const a = prescriptionFixture({ id: 'a', sortOrder: 2 });
    const b = prescriptionFixture({ id: 'b', sortOrder: 1 });
    const input = [a, b];

    const sorted = sortPrescriptionsByDisplayOrder(input);
    expect(input).toEqual([a, b]);
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('breaks ties on createdAt then id when sortOrders are equal', () => {
    const a = prescriptionFixture({
      id: 'a',
      sortOrder: 0,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const b = prescriptionFixture({
      id: 'b',
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const sorted = sortPrescriptionsByDisplayOrder([a, b]);
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('breaks ties on id when sortOrder and createdAt match', () => {
    const a = prescriptionFixture({
      id: 'zz',
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const b = prescriptionFixture({
      id: 'aa',
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const sorted = sortPrescriptionsByDisplayOrder([a, b]);
    expect(sorted.map((p) => p.id)).toEqual(['aa', 'zz']);
  });

  it('uses createdAt-then-id when no row has a numeric sortOrder', () => {
    const a = prescriptionFixture({
      id: 'a',
      createdAt: '2026-01-03T00:00:00.000Z',
      sortOrder: undefined,
    });
    const b = prescriptionFixture({
      id: 'b',
      createdAt: '2026-01-01T00:00:00.000Z',
      sortOrder: undefined,
    });
    const sorted = sortPrescriptionsByDisplayOrder([a, b]);
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('treats a single missing sortOrder as "not all have sortOrder" and falls back to createdAt', () => {
    const withOrder = prescriptionFixture({
      id: 'sorted-high',
      sortOrder: 100,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const withoutOrder = prescriptionFixture({
      id: 'unsorted-low',
      sortOrder: undefined,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // With order=100 vs none-at-all: because not all have it, we fall back to
    // createdAt comparison, and the earlier createdAt wins regardless of sortOrder.
    const sorted = sortPrescriptionsByDisplayOrder([withOrder, withoutOrder]);
    expect(sorted.map((p) => p.id)).toEqual(['unsorted-low', 'sorted-high']);
  });
});

describe('getProfile / saveProfile', () => {
  it('getProfile returns undefined when no profile exists', async () => {
    expect(await getProfile()).toBeUndefined();
  });

  it('saveProfile creates a profile with sensible defaults when none exists', async () => {
    await saveProfile({ startWeight: 200, goalWeight: 170 });

    const profile = await getProfile();
    expect(profile).toMatchObject({
      id: 'profile',
      startWeight: 200,
      goalWeight: 170,
      passphraseEnabled: false,
      syncMode: DEFAULT_SYNC_MODE,
    });
    expect(profile!.createdAt).toBeTruthy();
    expect(profile!.updatedAt).toBeTruthy();
  });

  it('saveProfile patches an existing profile and bumps updatedAt while preserving createdAt', async () => {
    await saveProfile({ startWeight: 200 });
    const created = await getProfile();
    expect(created!.startWeight).toBe(200);
    const originalCreatedAt = created!.createdAt;

    await new Promise((r) => setTimeout(r, 2));
    await saveProfile({ goalWeight: 165 });

    const after = await getProfile();
    expect(after).toMatchObject({
      id: 'profile',
      startWeight: 200,
      goalWeight: 165,
    });
    expect(after!.createdAt).toBe(originalCreatedAt);
    expect(after!.updatedAt >= originalCreatedAt).toBe(true);
  });

  it('saveProfile lets the caller override defaults like passphraseEnabled on first save', async () => {
    await saveProfile({ passphraseEnabled: true, syncMode: 'e2ee' });
    const profile = await getProfile();
    expect(profile!.passphraseEnabled).toBe(true);
    expect(profile!.syncMode).toBe('e2ee');
  });
});

describe('getProfileSyncMode', () => {
  it('returns DEFAULT_SYNC_MODE when profile is undefined', () => {
    expect(getProfileSyncMode(undefined)).toBe(DEFAULT_SYNC_MODE);
    expect(DEFAULT_SYNC_MODE).toBe('plain');
  });

  it('returns the profile syncMode when present', () => {
    const profile = {
      id: 'profile',
      passphraseEnabled: false,
      syncMode: 'e2ee',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } satisfies ProfileSettings;
    expect(getProfileSyncMode(profile)).toBe('e2ee');
  });

  it('returns DEFAULT_SYNC_MODE when profile exists but syncMode is undefined', () => {
    const profile = {
      id: 'profile',
      passphraseEnabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } satisfies ProfileSettings;
    expect(getProfileSyncMode(profile)).toBe(DEFAULT_SYNC_MODE);
  });
});

describe('clearAllData', () => {
  it('empties entries, prescriptions, and profile in one shot', async () => {
    await addEntry({ date: TODAY, weightLbs: 180 });
    await addEntry({ date: TODAY, amountMg: 5, medication: SEMA, site: '' });
    await addPrescription({ type: SEMA });
    await saveProfile({ startWeight: 200 });

    expect(await getAllEntries()).toHaveLength(2);
    expect(await getAllPrescriptions()).toHaveLength(1);
    expect(await getProfile()).toBeDefined();

    await clearAllData();

    expect(await getAllEntries()).toEqual([]);
    expect(await getAllPrescriptions()).toEqual([]);
    expect(await getProfile()).toBeUndefined();
  });
});

describe('edit gating during an E2EE migration', () => {
  // Bug 5: while the account is mid-migration (enable/disable/rotate) no device
  // may make data edits — steady-state sync is paused, and a stray edit landing
  // in the wrong table or under a retiring key is what wedges the migration.
  const migratingModes = ['migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key'] as const;

  for (const mode of migratingModes) {
    it(`rejects a health-data write while syncMode is ${mode}`, async () => {
      await setLocalProfileSyncState({ syncMode: mode });

      await expect(
        addEntry({ date: TODAY, weightLbs: 180 }),
      ).rejects.toBeInstanceOf(MigrationInProgressError);

      // The throw aborts the transaction: nothing persisted, nothing queued.
      expect(await getAllEntries()).toEqual([]);
      expect(await db.outbox.count()).toBe(0);
    });
  }

  it('still allows edits in steady-state e2ee (only migrating modes are gated)', async () => {
    await setLocalProfileSyncState({ syncMode: 'e2ee' });
    const created = await addEntry({ date: TODAY, weightLbs: 180 });
    expect(created.id).toBeTruthy();
    expect(await getAllEntries()).toHaveLength(1);
  });

  it('re-allows edits once the migration completes (mode returns to plain)', async () => {
    await setLocalProfileSyncState({ syncMode: 'migrating_to_e2ee' });
    await expect(addEntry({ date: TODAY, weightLbs: 180 })).rejects.toBeInstanceOf(
      MigrationInProgressError,
    );

    await setLocalProfileSyncState({ syncMode: 'plain' });
    await addEntry({ date: TODAY, weightLbs: 181 });
    expect(await getAllEntries()).toHaveLength(1);
  });

  it('does NOT block sync-apply writes (the migration drives those)', async () => {
    await setLocalProfileSyncState({ syncMode: 'migrating_to_e2ee' });

    // applyRemoteChange is the inbound counterpart — it bypasses the outbox and
    // must keep working so a migration's snapshot pull can land remote rows.
    const applied = await applyRemoteChange({
      aggregate: 'entry',
      entityId: 'w-remote',
      op: 'upsert',
      record: { id: 'w-remote', date: TODAY, weightLbs: 200, updatedAt: '2026-05-10T00:00:00.000Z' },
      remoteUpdatedAt: '2026-05-10T00:00:00.000Z',
    });

    expect(applied).toBe(true);
    expect(await getAllEntries()).toHaveLength(1);
  });
});

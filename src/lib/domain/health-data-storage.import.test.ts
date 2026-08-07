import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { db } from '$lib/db/schema';
import {
  addEntry,
  addPrescription,
  applyHealthDataImport,
  clearAllData,
  getAllEntries,
  getProfile,
  onHealthDataChange,
  type HealthDataChange,
} from './health-data-storage';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)' as const;

function importedDose(id: string, medication: typeof SEMA | typeof TIRZ) {
  return {
    id,
    date: iso('2026-05-10'),
    amountMg: 5,
    medication,
    site: '',
    symptoms: [],
    createdAt: '2026-05-10T12:00:00.000Z',
    updatedAt: '2026-05-10T12:00:00.000Z',
  };
}

describe('Health Data Storage imports', () => {
  it('deduplicates and applies a merge through one storage operation', async () => {
    await addEntry({ date: iso('2026-05-10'), weightLbs: 180 });
    const changes: HealthDataChange[] = [];
    const unsubscribe = onHealthDataChange((change) => changes.push(change));

    try {
      const result = await applyHealthDataImport({
        mode: 'merge',
        replaceProfile: false,
        data: {
          entries: [
            {
              id: 'duplicate',
              date: iso('2026-05-10'),
              weightLbs: 180,
              symptoms: [],
              createdAt: '2026-05-10T12:00:00.000Z',
              updatedAt: '2026-05-10T12:00:00.000Z',
            },
            {
              id: 'new-entry',
              date: iso('2026-05-11'),
              weightLbs: 179,
              symptoms: [],
              createdAt: '2026-05-11T12:00:00.000Z',
              updatedAt: '2026-05-11T12:00:00.000Z',
            },
          ],
          prescriptions: [],
        },
      });

      expect(result.skippedDuplicateEntries).toBe(1);
      expect(result.appliedEntries.map((entry) => entry.id)).toEqual(['new-entry']);
      expect((await getAllEntries()).map((entry) => entry.id)).toContain('new-entry');
      expect(changes).toEqual([{ action: 'add', entity: result.appliedEntries[0] }]);
    } finally {
      unsubscribe();
    }
  });

  it('deduplicates identical Doses within one import', async () => {
    const dose = importedDose('dose-1', SEMA);
    const result = await applyHealthDataImport({
      mode: 'merge',
      replaceProfile: false,
      data: { entries: [dose, { ...dose, id: 'dose-2' }], prescriptions: [] },
    });

    expect(result.skippedDuplicateEntries).toBe(1);
    expect(result.appliedEntries.map((entry) => entry.id)).toEqual(['dose-1']);
  });

  it('keeps same-day Doses for different Medications', async () => {
    const result = await applyHealthDataImport({
      mode: 'merge',
      replaceProfile: false,
      data: {
        entries: [importedDose('sema', SEMA), importedDose('tirz', TIRZ)],
        prescriptions: [],
      },
    });

    expect(result.skippedDuplicateEntries).toBe(0);
    expect(result.appliedEntries.map((entry) => entry.id)).toEqual(['sema', 'tirz']);
  });

  it('rejects the whole import from persisted Encryption Transition state', async () => {
    await db.profile.put({
      id: 'profile', passphraseEnabled: true, syncMode: 'migrating_to_e2ee',
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
    });

    await expect(applyHealthDataImport({
      mode: 'merge',
      replaceProfile: false,
      data: {
        entries: [{
          id: 'blocked', date: iso('2026-05-10'), weightLbs: 180, symptoms: [],
          createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        }],
        prescriptions: [],
      },
    })).rejects.toThrow(/encryption change is in progress/i);
    await expect(getAllEntries()).resolves.toEqual([]);
  });

  it('rejects an ordinary edit from persisted Encryption Transition state', async () => {
    await db.profile.put({
      id: 'profile', passphraseEnabled: true, syncMode: 'migrating_to_plain',
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
    });

    await expect(addEntry({ date: iso('2026-05-10'), weightLbs: 180 }))
      .rejects.toThrow(/encryption change is in progress/i);
    await expect(getAllEntries()).resolves.toEqual([]);
  });

  it('does not persist symptoms from a skipped duplicate Health Entry', async () => {
    await addEntry({ date: iso('2026-05-10'), weightLbs: 180 });

    const result = await applyHealthDataImport({
      mode: 'merge',
      replaceProfile: false,
      data: {
        entries: [{
          id: 'duplicate', date: iso('2026-05-10'), weightLbs: 180,
          symptoms: ['Brain fog'], createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        }],
        prescriptions: [],
      },
    });

    expect(result.skippedDuplicateEntries).toBe(1);
    await expect(getProfile()).resolves.toBeUndefined();
    await expect(db.outbox.get('profile:profile')).resolves.toBeUndefined();
  });

  it('rolls back replacement and publishes no changes when a write fails', async () => {
    const existing = await addEntry({ date: iso('2026-05-01'), weightLbs: 200 });
    const changes: HealthDataChange[] = [];
    const unsubscribe = onHealthDataChange((change) => changes.push(change));

    try {
      await expect(applyHealthDataImport({
        mode: 'replace',
        replaceProfile: true,
        data: {
          entries: [{ date: iso('2026-05-10'), weightLbs: 180 } as never],
          prescriptions: [],
        },
      })).rejects.toThrow();

      expect((await getAllEntries()).map((entry) => entry.id)).toEqual([existing.id]);
      expect(changes).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('creates replace tombstones and only one merged profile change', async () => {
    const removedEntry = await addEntry({ date: iso('2026-05-01'), weightLbs: 200 });
    const removedVial = await addPrescription({ type: SEMA });

    await applyHealthDataImport({
      mode: 'replace',
      replaceProfile: true,
      data: {
        entries: [{
          id: 'replacement', date: iso('2026-05-10'), weightLbs: 180,
          symptoms: ['Brain fog'], createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        }],
        prescriptions: [],
        profile: {
          id: 'profile', passphraseEnabled: false,
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    expect(await db.outbox.get(`entry:${removedEntry.id}`)).toMatchObject({ op: 'delete' });
    expect(await db.outbox.get(`prescription:${removedVial.id}`)).toMatchObject({ op: 'delete' });
    expect(await db.outbox.get('entry:replacement')).toMatchObject({ op: 'upsert' });
    const profileChanges = await db.outbox.where('aggregate').equals('profile').toArray();
    expect(profileChanges).toHaveLength(1);
    expect(profileChanges[0].payload).toMatchObject({
      symptomOptions: expect.arrayContaining(['Brain fog']),
    });
  });
});

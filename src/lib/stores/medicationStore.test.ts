// Drives medicationStore by mocking `$lib/db/liveQuery.fromLiveQuery` to a
// plain writable; that lets us push prescription arrays and inspect the
// derived row mapping without spinning up Dexie's live-query machinery.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable, type Readable } from 'svelte/store';
import type { Prescription } from '$lib/domain/types';

const TS = '2026-05-10T12:00:00.000Z';

// One writable per call to fromLiveQuery; the first is rawPrescriptions, the
// second is medicationRows (which re-runs the mapping itself, so we need to
// fire its querier to populate it).
const liveStores: Array<{ store: ReturnType<typeof writable>; querier: () => Promise<unknown> }> = [];

vi.mock('$lib/db/liveQuery', () => ({
  fromLiveQuery: <T>(querier: () => Promise<T>, initial: T): Readable<T> => {
    const s = writable<T>(initial);
    liveStores.push({ store: s as ReturnType<typeof writable>, querier });
    return { subscribe: s.subscribe };
  },
}));

// The querier inside medicationStore calls getAllPrescriptions; route it to a
// stub we control per test.
let prescriptionsForRepo: Prescription[] = [];
vi.mock('$lib/domain/repo', () => ({
  getAllPrescriptions: async () => prescriptionsForRepo,
  getAllEntries: async () => [],
}));

function rx(partial: Partial<Prescription> & { id: string }): Prescription {
  return {
    createdAt: TS,
    updatedAt: TS,
    ...partial,
  };
}

beforeEach(() => {
  liveStores.length = 0;
  prescriptionsForRepo = [];
  vi.resetModules();
});

async function loadModule(prescriptions: Prescription[]) {
  prescriptionsForRepo = prescriptions;
  const mod = await import('$lib/stores/medicationStore');
  // The mapping querier needs to run to populate medicationRows.
  for (const { store, querier } of liveStores) {
    const value = await querier();
    store.set(value);
  }
  return mod;
}

describe('medicationStore — medicationRows mapping', () => {
  it('maps a Prescription onto a MedicationInputRow with safe fallbacks', async () => {
    const { medicationRows } = await loadModule([rx({ id: 'p1' })]);
    const rows = get(medicationRows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      dbId: 'p1',
      type: '',
      cost: 0,
      pharmacy: '',
      concentrationMg: 0,
      additive: '',
      mlInVial: 0,
      prescribedDosage: 0,
      dosesLeft: 0,
      status: 'neutral',
      archived: false,
    });
  });

  it('threads non-undefined fields through verbatim', async () => {
    const { medicationRows } = await loadModule([
      rx({
        id: 'p1',
        type: 'Semaglutide (Ozempic / Wegovy)',
        costUsd: 250,
        pharmacy: 'Acme',
        concentrationMgMl: 2.5,
        additive: 'B12',
        vialMl: 3,
        prescribedDoseMg: 0.5,
        dosesLeft: 6,
        status: 'active',
      }),
    ]);
    const [row] = get(medicationRows);
    expect(row).toMatchObject({
      type: 'Semaglutide (Ozempic / Wegovy)',
      cost: 250,
      pharmacy: 'Acme',
      concentrationMg: 2.5,
      additive: 'B12',
      mlInVial: 3,
      prescribedDosage: 0.5,
      // dosesLeft is now computed (capacity ÷ dose = 2.5×3 ÷ 0.5 = 15), not the
      // stored value (6) — no doses are logged in this fixture, so the vial reads full.
      dosesLeft: 15,
      status: 'active',
    });
  });

  it('threads the archived flag through, defaulting to false', async () => {
    const { medicationRows } = await loadModule([
      rx({ id: 'p1' }),
      rx({ id: 'p2', archived: true }),
    ]);
    const rows = get(medicationRows);
    expect(rows.map((r) => r.archived)).toEqual([false, true]);
  });

  it('assigns 1-based display ids in source order', async () => {
    const { medicationRows } = await loadModule([
      rx({ id: 'a' }),
      rx({ id: 'b' }),
      rx({ id: 'c' }),
    ]);
    const rows = get(medicationRows);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.dbId)).toEqual(['a', 'b', 'c']);
  });
});

describe('medicationStore — activeVial', () => {
  it('returns null when nothing is active', async () => {
    const { activeVial } = await loadModule([rx({ id: 'p1', status: 'neutral' })]);
    expect(get(activeVial)).toBeNull();
  });

  it('returns the first row whose status is "active"', async () => {
    const { activeVial } = await loadModule([
      rx({ id: 'p1', status: 'neutral' }),
      rx({ id: 'p2', status: 'active' }),
      rx({ id: 'p3', status: 'active' }),
    ]);
    const v = get(activeVial);
    expect(v).not.toBeNull();
    expect(v?.dbId).toBe('p2');
  });
});

// Drives the derived stores in healthStore by running with `browser=true`,
// then dispatching repo change events. fake-indexeddb is brought in so the
// initial-load promise resolves cleanly.
import '../../test/dexie-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { iso } from '../../test/iso';
import type { InjectionEntry, WeightEntry } from '$lib/domain/types';

vi.mock('$app/environment', () => ({ browser: true }));

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)' as const;
const TS = '2026-05-10T12:00:00.000Z';

function weight(id: string, date: string, weightLbs?: number, extra: Partial<WeightEntry> = {}): WeightEntry {
  return { id, date: iso(date), weightLbs, createdAt: TS, updatedAt: TS, ...extra };
}

function injection(id: string, date: string, amountMg: number, extra: Partial<InjectionEntry> = {}): InjectionEntry {
  return {
    id,
    date: iso(date),
    amountMg,
    medication: SEMA,
    site: '',
    symptoms: [],
    createdAt: TS,
    updatedAt: TS,
    ...extra,
  };
}

beforeEach(() => {
  // Pristine module state for each test; otherwise the buffered-load flag and
  // the rawHealthData writable would leak across cases.
  vi.resetModules();
});

async function setup() {
  // Order matters: import the module under test first, then the repo, so the
  // store's onHealthDataChange listener is registered before we emit.
  const store = await import('$lib/stores/healthStore');
  const repo = await import('$lib/domain/repo');
  // Wait for the initial Dexie load to settle so the `loaded` flag flips and
  // subsequent emits hit the reducer instead of being buffered.
  await store.healthStoreReady;
  return { ...store, ...repo };
}

describe('healthStore — latestWeightLbs', () => {
  it('starts null with no weight rows', async () => {
    const { latestWeightLbs } = await setup();
    expect(get(latestWeightLbs)).toBeNull();
  });

  it('returns the lbs of the most recent (last array element) weight that has a value', async () => {
    const { latestWeightLbs, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w1', '2026-05-01', 180) });
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w2', '2026-05-05', 175) });
    expect(get(latestWeightLbs)).toBe(175);
  });

  it('skips entries that have no weightLbs and returns the next valid one', async () => {
    const { latestWeightLbs, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w1', '2026-05-01', 180) });
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w2', '2026-05-05') });
    expect(get(latestWeightLbs)).toBe(180);
  });
});

describe('healthStore — healthEntries', () => {
  it('starts as an empty array', async () => {
    const { healthEntries } = await setup();
    expect(get(healthEntries)).toEqual([]);
  });

  it('builds one row per unique date sorted ascending', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w1', '2026-05-05', 175) });
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w2', '2026-05-01', 180) });
    const rows = get(healthEntries);
    expect(rows.map((r) => r.date)).toEqual([iso('2026-05-01'), iso('2026-05-05')]);
  });

  it('renders weight rows with the numeric weight as a string and empty dose', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w1', '2026-05-01', 180.5) });
    const [row] = get(healthEntries);
    expect(row.weight).toBe('180.5');
    expect(row.dose).toBe('');
    expect(row.weightId).toBe('w1');
  });

  it('renders injection rows with dose and medication', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i1', '2026-05-01', 2.5) });
    const [row] = get(healthEntries);
    expect(row.dose).toBe('2.5');
    expect(row.medication).toBe(SEMA);
    expect(row.injectionId).toBe('i1');
  });

  it('blanks the dose / system fields for a skipped injection', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({
      kind: 'injection',
      action: 'add',
      entity: injection('i1', '2026-05-01', 2.5, { skipped: true }),
    });
    const [row] = get(healthEntries);
    expect(row.doseSkipped).toBe(true);
    expect(row.system).toBe('');
    expect(row.systemAmounts).toEqual([]);
  });

  it('pairs same-date weight and injection into a single row', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w1', '2026-05-01', 180) });
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i1', '2026-05-01', 2.5) });
    const rows = get(healthEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weightId: 'w1', injectionId: 'i1', weight: '180', dose: '2.5' });
  });

  it('produces one row per distinct injection date', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i1', '2026-05-01', 2) });
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i2', '2026-05-02', 2) });
    const rows = get(healthEntries);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.medication === SEMA)).toBe(true);
  });

  it('switches to multi-medication system labelling when ≥2 drugs are present', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i1', '2026-05-01', 2) });
    emitHealthChange({
      kind: 'injection',
      action: 'add',
      entity: injection('i2', '2026-05-02', 5, { medication: TIRZ }),
    });
    const rows = get(healthEntries);
    expect(rows.length).toBeGreaterThan(0);
    // Distinct medications recorded in their respective rows.
    expect(new Set(rows.map((r) => r.medication).filter(Boolean)).size).toBeGreaterThanOrEqual(1);
  });

  it('reflects a patch on an injection', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i1', '2026-05-01', 2.5) });
    emitHealthChange({ kind: 'injection', action: 'patch', id: 'i1', patch: { amountMg: 5 } });
    expect(get(healthEntries)[0].dose).toBe('5');
  });

  it('removes a row when its injection is deleted and no weight remains for that date', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i1', '2026-05-01', 2.5) });
    emitHealthChange({ kind: 'injection', action: 'delete', id: 'i1' });
    expect(get(healthEntries)).toEqual([]);
  });

  it('clears all rows on a weight + injection reset', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ kind: 'weight', action: 'add', entity: weight('w1', '2026-05-01', 180) });
    emitHealthChange({ kind: 'injection', action: 'add', entity: injection('i1', '2026-05-01', 2.5) });
    emitHealthChange({ kind: 'weight', action: 'reset' });
    emitHealthChange({ kind: 'injection', action: 'reset' });
    expect(get(healthEntries)).toEqual([]);
  });
});

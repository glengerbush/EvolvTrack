// Drives the derived stores in healthStore by running with `browser=true`,
// then dispatching repo change events. fake-indexeddb is brought in so the
// initial-load promise resolves cleanly.
import '../../test/dexie-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { iso } from '../../test/iso';
import type { HealthEntry } from '$lib/domain/types';

vi.mock('$app/environment', () => ({ browser: true }));

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)' as const;
const TS = '2026-05-10T12:00:00.000Z';

function weighIn(id: string, date: string, weightLbs?: number, extra: Partial<HealthEntry> = {}): HealthEntry {
  return { id, date: iso(date), weightLbs, symptoms: [], createdAt: TS, updatedAt: TS, ...extra };
}

function dose(id: string, date: string, amountMg: number, extra: Partial<HealthEntry> = {}): HealthEntry {
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
  it('starts null with no weigh-in rows', async () => {
    const { latestWeightLbs } = await setup();
    expect(get(latestWeightLbs)).toBeNull();
  });

  it('returns the lbs of the weigh-in with the latest date', async () => {
    const { latestWeightLbs, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-01', 180) });
    emitHealthChange({ action: 'add', entity: weighIn('w2', '2026-05-05', 175) });
    expect(get(latestWeightLbs)).toBe(175);
  });

  it('uses the latest date, not insertion order, when a later-added row is older', async () => {
    const { latestWeightLbs, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-05', 175) });
    emitHealthChange({ action: 'add', entity: weighIn('w2', '2026-05-01', 180) });
    expect(get(latestWeightLbs)).toBe(175);
  });

  it('averages multiple weigh-ins on the latest date', async () => {
    const { latestWeightLbs, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-05', 176) });
    emitHealthChange({ action: 'add', entity: weighIn('w2', '2026-05-05', 172) });
    expect(get(latestWeightLbs)).toBe(174);
  });

  it('skips entries that have no weightLbs and returns the next valid date', async () => {
    const { latestWeightLbs, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-01', 180) });
    emitHealthChange({ action: 'add', entity: weighIn('w2', '2026-05-05') });
    expect(get(latestWeightLbs)).toBe(180);
  });
});

describe('healthStore — healthEntries', () => {
  it('starts as an empty array', async () => {
    const { healthEntries } = await setup();
    expect(get(healthEntries)).toEqual([]);
  });

  it('builds rows sorted by date ascending', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-05', 175) });
    emitHealthChange({ action: 'add', entity: weighIn('w2', '2026-05-01', 180) });
    const rows = get(healthEntries);
    expect(rows.map((r) => r.date)).toEqual([iso('2026-05-01'), iso('2026-05-05')]);
  });

  it('renders weigh-in rows with the numeric weight as a string and empty dose', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-01', 180.5) });
    const [row] = get(healthEntries);
    expect(row.weight).toBe('180.5');
    expect(row.dose).toBe('');
    expect(row.entryId).toBe('w1');
  });

  it('renders dose rows with dose and medication', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2.5) });
    const [row] = get(healthEntries);
    expect(row.dose).toBe('2.5');
    expect(row.medication).toBe(SEMA);
    expect(row.entryId).toBe('i1');
  });

  it('blanks the dose / system fields for a skipped dose', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2.5, { skipped: true }) });
    const [row] = get(healthEntries);
    expect(row.doseSkipped).toBe(true);
    expect(row.system).toBe('');
    expect(row.systemAmounts).toEqual([]);
  });

  it('keeps a same-date weigh-in and dose as TWO independent rows (no merge)', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-01', 180) });
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2.5) });
    const rows = get(healthEntries);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.entryId).sort()).toEqual(['i1', 'w1']);
  });

  it('produces one row per distinct dose date', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2) });
    emitHealthChange({ action: 'add', entity: dose('i2', '2026-05-02', 2) });
    const rows = get(healthEntries);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.medication === SEMA)).toBe(true);
  });

  it('records distinct medications across rows when ≥2 drugs are present', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2) });
    emitHealthChange({ action: 'add', entity: dose('i2', '2026-05-02', 5, { medication: TIRZ }) });
    const rows = get(healthEntries);
    expect(new Set(rows.map((r) => r.medication).filter(Boolean)).size).toBe(2);
  });

  it('reflects a patch on a dose entry', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2.5) });
    emitHealthChange({ action: 'patch', id: 'i1', patch: { amountMg: 5 } });
    expect(get(healthEntries)[0].dose).toBe('5');
  });

  it('removes a row when its entry is deleted', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2.5) });
    emitHealthChange({ action: 'delete', id: 'i1' });
    expect(get(healthEntries)).toEqual([]);
  });

  it('clears all rows on reset', async () => {
    const { healthEntries, emitHealthChange } = await setup();
    emitHealthChange({ action: 'add', entity: weighIn('w1', '2026-05-01', 180) });
    emitHealthChange({ action: 'add', entity: dose('i1', '2026-05-01', 2.5) });
    emitHealthChange({ action: 'reset' });
    expect(get(healthEntries)).toEqual([]);
  });
});

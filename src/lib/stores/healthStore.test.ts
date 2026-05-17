import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import { applyHealthChange, type RawHealthData } from '$lib/stores/healthStore';
import type { InjectionEntry, WeightEntry } from '$lib/domain/types';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TS = '2026-05-10T12:00:00.000Z';
const DATE = iso('2026-05-10');

function weight(id: string, weightLbs: number): WeightEntry {
  return { id, date: DATE, weightLbs, createdAt: TS, updatedAt: TS };
}

function injection(id: string, amountMg: number): InjectionEntry {
  return {
    id,
    date: DATE,
    amountMg,
    medication: SEMA,
    site: '',
    symptoms: [],
    createdAt: TS,
    updatedAt: TS,
  };
}

function emptyState(): RawHealthData {
  return { weights: [], injections: [] };
}

describe('applyHealthChange — weights', () => {
  it('add inserts a new weight when the id is unknown', () => {
    const state = emptyState();
    const next = applyHealthChange(state, {
      kind: 'weight',
      action: 'add',
      entity: weight('w1', 180),
    });
    expect(next.weights).toEqual([weight('w1', 180)]);
  });

  it('add upserts in place when the id already exists', () => {
    const state: RawHealthData = { weights: [weight('w1', 180), weight('w2', 175)], injections: [] };
    const next = applyHealthChange(state, {
      kind: 'weight',
      action: 'add',
      entity: weight('w1', 178),
    });
    expect(next.weights).toHaveLength(2);
    expect(next.weights[0]).toMatchObject({ id: 'w1', weightLbs: 178 });
    expect(next.weights[1]).toMatchObject({ id: 'w2', weightLbs: 175 });
  });

  it('patch merges fields onto the matching entry and leaves others untouched', () => {
    const state: RawHealthData = { weights: [weight('w1', 180), weight('w2', 175)], injections: [] };
    const next = applyHealthChange(state, {
      kind: 'weight',
      action: 'patch',
      id: 'w1',
      patch: { weightLbs: 178, notes: 'ate light' },
    });
    expect(next.weights[0]).toMatchObject({ id: 'w1', weightLbs: 178, notes: 'ate light' });
    expect(next.weights[1]).toEqual(state.weights[1]);
  });

  it('patch is a no-op when the id is missing', () => {
    const state: RawHealthData = { weights: [weight('w1', 180)], injections: [] };
    const next = applyHealthChange(state, {
      kind: 'weight',
      action: 'patch',
      id: 'ghost',
      patch: { weightLbs: 0 },
    });
    expect(next.weights).toEqual(state.weights);
  });

  it('delete removes the matching weight by id', () => {
    const state: RawHealthData = { weights: [weight('w1', 180), weight('w2', 175)], injections: [] };
    const next = applyHealthChange(state, { kind: 'weight', action: 'delete', id: 'w1' });
    expect(next.weights).toEqual([weight('w2', 175)]);
  });

  it('reset clears all weights but leaves injections untouched', () => {
    const state: RawHealthData = { weights: [weight('w1', 180)], injections: [injection('i1', 5)] };
    const next = applyHealthChange(state, { kind: 'weight', action: 'reset' });
    expect(next.weights).toEqual([]);
    expect(next.injections).toEqual([injection('i1', 5)]);
  });
});

describe('applyHealthChange — injections', () => {
  it('add inserts a new injection', () => {
    const next = applyHealthChange(emptyState(), {
      kind: 'injection',
      action: 'add',
      entity: injection('i1', 5),
    });
    expect(next.injections).toEqual([injection('i1', 5)]);
  });

  it('add upserts when id already exists (import-merge case)', () => {
    const state: RawHealthData = { weights: [], injections: [injection('i1', 5)] };
    const next = applyHealthChange(state, {
      kind: 'injection',
      action: 'add',
      entity: injection('i1', 7),
    });
    expect(next.injections).toHaveLength(1);
    expect(next.injections[0]).toMatchObject({ id: 'i1', amountMg: 7 });
  });

  it('patch updates the matching injection', () => {
    const state: RawHealthData = { weights: [], injections: [injection('i1', 5)] };
    const next = applyHealthChange(state, {
      kind: 'injection',
      action: 'patch',
      id: 'i1',
      patch: { amountMg: 9, skipped: true },
    });
    expect(next.injections[0]).toMatchObject({ id: 'i1', amountMg: 9, skipped: true });
  });

  it('delete removes the matching injection', () => {
    const state: RawHealthData = { weights: [], injections: [injection('i1', 5), injection('i2', 7)] };
    const next = applyHealthChange(state, { kind: 'injection', action: 'delete', id: 'i1' });
    expect(next.injections).toEqual([injection('i2', 7)]);
  });

  it('reset clears all injections but leaves weights untouched', () => {
    const state: RawHealthData = { weights: [weight('w1', 180)], injections: [injection('i1', 5)] };
    const next = applyHealthChange(state, { kind: 'injection', action: 'reset' });
    expect(next.injections).toEqual([]);
    expect(next.weights).toEqual([weight('w1', 180)]);
  });

  it('bulkPatch applies the same patch to every targeted id in one pass', () => {
    const state: RawHealthData = {
      weights: [],
      injections: [injection('i1', 5), injection('i2', 7), injection('i3', 9)],
    };
    const next = applyHealthChange(state, {
      kind: 'injection',
      action: 'bulkPatch',
      ids: ['i1', 'i3'],
      patch: { medication: 'Tirzepatide (Mounjaro / Zepbound)', updatedAt: '2026-05-11T00:00:00.000Z' },
    });
    expect(next.injections[0]).toMatchObject({
      id: 'i1',
      medication: 'Tirzepatide (Mounjaro / Zepbound)',
      updatedAt: '2026-05-11T00:00:00.000Z',
    });
    expect(next.injections[1]).toEqual(state.injections[1]);
    expect(next.injections[2]).toMatchObject({
      id: 'i3',
      medication: 'Tirzepatide (Mounjaro / Zepbound)',
      updatedAt: '2026-05-11T00:00:00.000Z',
    });
  });

  it('bulkPatch with an empty id list is a no-op and returns the same state reference', () => {
    const state: RawHealthData = { weights: [], injections: [injection('i1', 5)] };
    const next = applyHealthChange(state, {
      kind: 'injection',
      action: 'bulkPatch',
      ids: [],
      patch: { medication: SEMA },
    });
    expect(next).toBe(state);
  });

  it('bulkPatch ignores ids that do not match any injection', () => {
    const state: RawHealthData = { weights: [], injections: [injection('i1', 5)] };
    const next = applyHealthChange(state, {
      kind: 'injection',
      action: 'bulkPatch',
      ids: ['ghost-1', 'ghost-2'],
      patch: { amountMg: 0 },
    });
    expect(next.injections).toEqual(state.injections);
  });
});

describe('applyHealthChange — immutability', () => {
  it('does not mutate the input state', () => {
    const state: RawHealthData = { weights: [weight('w1', 180)], injections: [injection('i1', 5)] };
    const snapshot = JSON.stringify(state);
    applyHealthChange(state, { kind: 'weight', action: 'add', entity: weight('w2', 175) });
    applyHealthChange(state, { kind: 'weight', action: 'patch', id: 'w1', patch: { weightLbs: 0 } });
    applyHealthChange(state, { kind: 'weight', action: 'delete', id: 'w1' });
    applyHealthChange(state, {
      kind: 'injection',
      action: 'bulkPatch',
      ids: ['i1'],
      patch: { amountMg: 99 },
    });
    applyHealthChange(state, { kind: 'injection', action: 'reset' });
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

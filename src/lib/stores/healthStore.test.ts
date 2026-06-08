import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import { applyHealthChange, type RawHealthData } from '$lib/stores/healthStore';
import type { HealthEntry } from '$lib/domain/types';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TS = '2026-05-10T12:00:00.000Z';
const DATE = iso('2026-05-10');

function weighIn(id: string, weightLbs: number): HealthEntry {
  return { id, date: DATE, weightLbs, symptoms: [], createdAt: TS, updatedAt: TS };
}

function dose(id: string, amountMg: number): HealthEntry {
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
  return { entries: [] };
}

describe('applyHealthChange — add / patch / delete', () => {
  it('add inserts a new entry when the id is unknown', () => {
    const next = applyHealthChange(emptyState(), { action: 'add', entity: weighIn('e1', 180) });
    expect(next.entries).toEqual([weighIn('e1', 180)]);
  });

  it('add upserts in place when the id already exists', () => {
    const state: RawHealthData = { entries: [weighIn('e1', 180), weighIn('e2', 175)] };
    const next = applyHealthChange(state, { action: 'add', entity: weighIn('e1', 178) });
    expect(next.entries).toHaveLength(2);
    expect(next.entries[0]).toMatchObject({ id: 'e1', weightLbs: 178 });
    expect(next.entries[1]).toMatchObject({ id: 'e2', weightLbs: 175 });
  });

  it('patch merges fields onto the matching entry and leaves others untouched', () => {
    const state: RawHealthData = { entries: [weighIn('e1', 180), weighIn('e2', 175)] };
    const next = applyHealthChange(state, {
      action: 'patch',
      id: 'e1',
      patch: { weightLbs: 178, notes: 'ate light' },
    });
    expect(next.entries[0]).toMatchObject({ id: 'e1', weightLbs: 178, notes: 'ate light' });
    expect(next.entries[1]).toEqual(state.entries[1]);
  });

  it('patch is a no-op when the id is missing', () => {
    const state: RawHealthData = { entries: [weighIn('e1', 180)] };
    const next = applyHealthChange(state, { action: 'patch', id: 'ghost', patch: { weightLbs: 0 } });
    expect(next.entries).toEqual(state.entries);
  });

  it('delete removes the matching entry by id', () => {
    const state: RawHealthData = { entries: [weighIn('e1', 180), dose('e2', 5)] };
    const next = applyHealthChange(state, { action: 'delete', id: 'e1' });
    expect(next.entries).toEqual([dose('e2', 5)]);
  });

  it('reset clears all entries', () => {
    const state: RawHealthData = { entries: [weighIn('e1', 180), dose('e2', 5)] };
    const next = applyHealthChange(state, { action: 'reset' });
    expect(next.entries).toEqual([]);
  });
});

describe('applyHealthChange — bulkPatch', () => {
  it('applies the same patch to every targeted id in one pass', () => {
    const state: RawHealthData = { entries: [dose('i1', 5), dose('i2', 7), dose('i3', 9)] };
    const next = applyHealthChange(state, {
      action: 'bulkPatch',
      ids: ['i1', 'i3'],
      patch: { medication: 'Tirzepatide (Mounjaro / Zepbound)', updatedAt: '2026-05-11T00:00:00.000Z' },
    });
    expect(next.entries[0]).toMatchObject({
      id: 'i1',
      medication: 'Tirzepatide (Mounjaro / Zepbound)',
      updatedAt: '2026-05-11T00:00:00.000Z',
    });
    expect(next.entries[1]).toEqual(state.entries[1]);
    expect(next.entries[2]).toMatchObject({
      id: 'i3',
      medication: 'Tirzepatide (Mounjaro / Zepbound)',
      updatedAt: '2026-05-11T00:00:00.000Z',
    });
  });

  it('with an empty id list is a no-op and returns the same state reference', () => {
    const state: RawHealthData = { entries: [dose('i1', 5)] };
    const next = applyHealthChange(state, { action: 'bulkPatch', ids: [], patch: { medication: SEMA } });
    expect(next).toBe(state);
  });

  it('ignores ids that do not match any entry', () => {
    const state: RawHealthData = { entries: [dose('i1', 5)] };
    const next = applyHealthChange(state, {
      action: 'bulkPatch',
      ids: ['ghost-1', 'ghost-2'],
      patch: { amountMg: 0 },
    });
    expect(next.entries).toEqual(state.entries);
  });
});

describe('applyHealthChange — immutability', () => {
  it('does not mutate the input state', () => {
    const state: RawHealthData = { entries: [weighIn('e1', 180), dose('i1', 5)] };
    const snapshot = JSON.stringify(state);
    applyHealthChange(state, { action: 'add', entity: weighIn('e2', 175) });
    applyHealthChange(state, { action: 'patch', id: 'e1', patch: { weightLbs: 0 } });
    applyHealthChange(state, { action: 'delete', id: 'e1' });
    applyHealthChange(state, { action: 'bulkPatch', ids: ['i1'], patch: { amountMg: 99 } });
    applyHealthChange(state, { action: 'reset' });
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

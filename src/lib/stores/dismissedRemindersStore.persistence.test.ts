// @vitest-environment happy-dom
// Persistence / hydration coverage for dismissedRemindersStore. The behavior
// tests live next door in dismissedRemindersStore.test.ts; this file focuses on
// what happens at module-load time (localStorage hydration, age cutoff, malformed
// payload tolerance) and on the writable persist side-effect.
//
// Source uses `typeof window === 'undefined'` to gate persistence, so we run
// under happy-dom (window exists) and rely on `src/test/setup.ts`'s in-memory
// `localStorage` shim.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'evolvtrack:dismissedReminders';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function load() {
  return (await import('$lib/stores/dismissedRemindersStore')).dismissedReminders;
}

describe('dismissedReminders — hydration from localStorage', () => {
  it('starts empty when nothing is stored', async () => {
    const dr = await load();
    const { get } = await import('svelte/store');
    expect(get(dr)).toEqual({ bud: {}, refill: {} });
  });

  it('starts empty on malformed JSON instead of throwing', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const dr = await load();
    const { get } = await import('svelte/store');
    expect(get(dr)).toEqual({ bud: {}, refill: {} });
  });

  it('hydrates valid BUD and refill entries', async () => {
    const recent = new Date().toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        bud: { 'rx-1': { bud: '2026-06-01', dismissedAt: recent } },
        refill: { Semaglutide: { atDoses: 3, dismissedAt: recent } },
      }),
    );
    const dr = await load();
    const { get } = await import('svelte/store');
    const state = get(dr);
    expect(state.bud['rx-1']).toMatchObject({ bud: '2026-06-01' });
    expect(state.refill['Semaglutide']).toMatchObject({ atDoses: 3 });
  });

  it('drops entries older than 90 days at load time', async () => {
    const old = new Date(Date.now() - 91 * DAY_MS).toISOString();
    const recent = new Date().toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        bud: {
          stale: { bud: '2024-01-01', dismissedAt: old },
          fresh: { bud: '2026-06-01', dismissedAt: recent },
        },
        refill: {
          stale: { atDoses: 1, dismissedAt: old },
          fresh: { atDoses: 2, dismissedAt: recent },
        },
      }),
    );
    const dr = await load();
    const { get } = await import('svelte/store');
    const state = get(dr);
    expect(state.bud).toHaveProperty('fresh');
    expect(state.bud).not.toHaveProperty('stale');
    expect(state.refill).toHaveProperty('fresh');
    expect(state.refill).not.toHaveProperty('stale');
  });

  it('ignores entries whose shape does not match the type guard', async () => {
    const recent = new Date().toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        bud: {
          good: { bud: '2026-06-01', dismissedAt: recent },
          bad: { dismissedAt: recent }, // missing bud
          garbage: 'nope',
        },
        refill: {
          good: { atDoses: 3, dismissedAt: recent },
          bad: { atDoses: 'three', dismissedAt: recent }, // wrong type
        },
      }),
    );
    const dr = await load();
    const { get } = await import('svelte/store');
    const state = get(dr);
    expect(Object.keys(state.bud)).toEqual(['good']);
    expect(Object.keys(state.refill)).toEqual(['good']);
  });
});

describe('dismissedReminders — persistence side-effects', () => {
  it('writes to localStorage when a BUD is dismissed', async () => {
    const dr = await load();
    dr.dismissBud('rx-1', '2026-06-01');
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.bud['rx-1'].bud).toBe('2026-06-01');
  });

  it('writes to localStorage when a refill is dismissed', async () => {
    const dr = await load();
    dr.dismissRefill('Semaglutide', 3);
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.refill['Semaglutide'].atDoses).toBe(3);
  });

  it('clears storage on restoreAll', async () => {
    const dr = await load();
    dr.dismissBud('rx-1', '2026-06-01');
    dr.restoreAll();
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(parsed).toEqual({ bud: {}, refill: {} });
  });

  it('persists the post-reconcile state when something actually changed', async () => {
    const dr = await load();
    dr.dismissBud('rx-1', '2026-06-01');
    dr.dismissBud('rx-2', '2026-06-15');
    dr.reconcile({
      knownPrescriptionIds: new Set(['rx-1']),
      refillSupplyByType: new Map(),
      refillThreshold: 4,
    });
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.bud).toHaveProperty('rx-1');
    expect(parsed.bud).not.toHaveProperty('rx-2');
  });
});

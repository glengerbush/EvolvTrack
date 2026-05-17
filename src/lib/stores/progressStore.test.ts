// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

// Source uses `typeof window === 'undefined'` to gate persistence, so we run
// under happy-dom (window exists) and rely on `src/test/setup.ts`'s in-memory
// `localStorage` shim.

// Replace healthStore's derived stores with writables we can drive.
const latestWeightLbs = writable<number | null>(null);
vi.mock('$lib/stores/healthStore', () => ({ latestWeightLbs }));

const START_KEY = 'evolvtrack-start-weight';
const GOAL_KEY = 'evolvtrack-goal-weight';

beforeEach(() => {
  localStorage.clear();
  latestWeightLbs.set(null);
  vi.resetModules();
});

async function load() {
  return import('$lib/stores/progressStore');
}

describe('progressStore — startWeight default and persistence', () => {
  it('defaults to null when no localStorage value is present', async () => {
    const { startWeight } = await load();
    const { get } = await import('svelte/store');
    expect(get(startWeight)).toBeNull();
  });

  it('hydrates from localStorage when a numeric value is present', async () => {
    localStorage.setItem(START_KEY, '215.5');
    const { startWeight } = await load();
    const { get } = await import('svelte/store');
    expect(get(startWeight)).toBe(215.5);
  });

  it('falls back to null when the stored value is not finite', async () => {
    localStorage.setItem(START_KEY, 'not-a-number');
    const { startWeight } = await load();
    const { get } = await import('svelte/store');
    expect(get(startWeight)).toBeNull();
  });

  it('set persists the value back to localStorage and updates the store', async () => {
    const { startWeight } = await load();
    const { get } = await import('svelte/store');
    startWeight.set(190);
    expect(get(startWeight)).toBe(190);
    expect(localStorage.getItem(START_KEY)).toBe('190');
  });

  it('setting null removes the localStorage entry', async () => {
    localStorage.setItem(START_KEY, '190');
    const { startWeight } = await load();
    const { get } = await import('svelte/store');
    startWeight.set(null);
    expect(get(startWeight)).toBeNull();
    expect(localStorage.getItem(START_KEY)).toBeNull();
  });
});

describe('progressStore — goalWeight', () => {
  it('defaults to null', async () => {
    const { goalWeight } = await load();
    const { get } = await import('svelte/store');
    expect(get(goalWeight)).toBeNull();
  });

  it('persists and updates on set', async () => {
    const { goalWeight } = await load();
    const { get } = await import('svelte/store');
    goalWeight.set(155);
    expect(localStorage.getItem(GOAL_KEY)).toBe('155');
    expect(get(goalWeight)).toBe(155);
  });
});

describe('progressStore — currentWeight', () => {
  it('is null when latestWeightLbs is null', async () => {
    latestWeightLbs.set(null);
    const { currentWeight } = await load();
    const { get } = await import('svelte/store');
    expect(get(currentWeight)).toBeNull();
  });

  it('mirrors latestWeightLbs when it has a value', async () => {
    latestWeightLbs.set(174.2);
    const { currentWeight } = await load();
    const { get } = await import('svelte/store');
    expect(get(currentWeight)).toBe(174.2);
  });

  it('updates reactively when the source store changes', async () => {
    latestWeightLbs.set(175);
    const { currentWeight } = await load();
    const { get } = await import('svelte/store');
    expect(get(currentWeight)).toBe(175);
    latestWeightLbs.set(170);
    expect(get(currentWeight)).toBe(170);
    latestWeightLbs.set(null);
    expect(get(currentWeight)).toBeNull();
  });
});

describe('progressStore — setStartWeightIfUnset', () => {
  it('sets startWeight when none is stored', async () => {
    const { startWeight, setStartWeightIfUnset } = await load();
    const { get } = await import('svelte/store');
    setStartWeightIfUnset(212.4);
    expect(get(startWeight)).toBe(212.4);
    expect(localStorage.getItem(START_KEY)).toBe('212.4');
  });

  it('leaves an existing startWeight untouched', async () => {
    localStorage.setItem(START_KEY, '198');
    const { startWeight, setStartWeightIfUnset } = await load();
    const { get } = await import('svelte/store');
    setStartWeightIfUnset(212.4);
    expect(get(startWeight)).toBe(198);
  });

  it('ignores null and non-finite inputs', async () => {
    const { startWeight, setStartWeightIfUnset } = await load();
    const { get } = await import('svelte/store');
    setStartWeightIfUnset(null);
    setStartWeightIfUnset(Number.NaN);
    expect(get(startWeight)).toBeNull();
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Source uses `typeof window === 'undefined'` to gate persistence, so we run
// under happy-dom (window exists) and rely on `src/test/setup.ts`'s in-memory
// `localStorage` shim.

const seedDemoData = vi.fn(async () => {});
const clearDemoData = vi.fn(async () => {});

vi.mock('$lib/db/seed', () => ({
  seedDemoData: () => seedDemoData(),
  clearDemoData: () => clearDemoData(),
}));

const STORAGE_KEY = 'evolvtrack-demo-mode';

beforeEach(() => {
  localStorage.clear();
  seedDemoData.mockClear();
  clearDemoData.mockClear();
  vi.resetModules();
});

async function freshStore() {
  return (await import('$lib/stores/demoStore')).isDemoMode;
}

describe('isDemoMode — initial value', () => {
  it('reads false when nothing is stored', async () => {
    const isDemoMode = await freshStore();
    const { get } = await import('svelte/store');
    expect(get(isDemoMode)).toBe(false);
  });

  it('reads true when localStorage flag is set', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const isDemoMode = await freshStore();
    const { get } = await import('svelte/store');
    expect(get(isDemoMode)).toBe(true);
  });

  it('reads false for any value other than the literal "true"', async () => {
    localStorage.setItem(STORAGE_KEY, '1');
    const isDemoMode = await freshStore();
    const { get } = await import('svelte/store');
    expect(get(isDemoMode)).toBe(false);
  });
});

describe('isDemoMode — enable', () => {
  it('persists the flag, sets the store, and seeds the DB', async () => {
    const isDemoMode = await freshStore();
    const { get } = await import('svelte/store');
    await isDemoMode.enable();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    expect(get(isDemoMode)).toBe(true);
    expect(seedDemoData).toHaveBeenCalledTimes(1);
  });
});

describe('isDemoMode — disable', () => {
  it('removes the flag, clears the store, and clears the DB', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const isDemoMode = await freshStore();
    const { get } = await import('svelte/store');
    await isDemoMode.disable();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(get(isDemoMode)).toBe(false);
    expect(clearDemoData).toHaveBeenCalledTimes(1);
  });
});

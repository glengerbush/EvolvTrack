// @vitest-environment happy-dom
import '../../test/dexie-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

// Start/goal weight now live on the synced `profile` row; the store writes them
// via real Health Data Storage against fake-indexeddb. localStorage is just a first-paint
// cache. `browser` is left at its default (false) so the liveQuery hydrator
// doesn't fire — the `.set` path updates the in-memory writable synchronously
// and persists to the profile, which is the behavior these tests assert.

// Replace healthStore's derived store with a writable we can drive.
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

describe('progressStore — startWeight', () => {
  it('defaults to null when nothing is cached', async () => {
    const { startWeight } = await load();
    expect(get(startWeight)).toBeNull();
  });

  it('hydrates synchronously from the localStorage cache', async () => {
    localStorage.setItem(START_KEY, '215.5');
    const { startWeight } = await load();
    expect(get(startWeight)).toBe(215.5);
  });

  it('falls back to null when the cached value is not finite', async () => {
    localStorage.setItem(START_KEY, 'not-a-number');
    const { startWeight } = await load();
    expect(get(startWeight)).toBeNull();
  });

  it('set persists to the synced profile and the cache', async () => {
    const { startWeight } = await load();
    const { getProfile } = await import('$lib/domain/health-data-storage');
    startWeight.set(190);
    expect(get(startWeight)).toBe(190);
    expect(localStorage.getItem(START_KEY)).toBe('190');
    await vi.waitFor(async () => {
      const profile = await getProfile();
      expect(profile?.startWeight).toBe(190);
      // The per-field LWW clock is stamped, which is what lets it sync.
      expect(profile?.fieldUpdatedAt?.startWeight).toBeTruthy();
    });
  });

  it('setting null clears the profile field and the cache', async () => {
    const { startWeight } = await load();
    const { getProfile } = await import('$lib/domain/health-data-storage');
    // Seed through the store, waiting for the (fire-and-forget) write to land.
    startWeight.set(190);
    await vi.waitFor(async () => expect((await getProfile())?.startWeight).toBe(190));
    startWeight.set(null);
    expect(get(startWeight)).toBeNull();
    expect(localStorage.getItem(START_KEY)).toBeNull();
    await vi.waitFor(async () =>
      expect((await getProfile())?.startWeight).toBeUndefined(),
    );
  });
});

describe('progressStore — goalWeight', () => {
  it('defaults to null', async () => {
    const { goalWeight } = await load();
    expect(get(goalWeight)).toBeNull();
  });

  it('persists to the profile and cache on set', async () => {
    const { goalWeight } = await load();
    const { getProfile } = await import('$lib/domain/health-data-storage');
    goalWeight.set(155);
    expect(get(goalWeight)).toBe(155);
    expect(localStorage.getItem(GOAL_KEY)).toBe('155');
    await vi.waitFor(async () => expect((await getProfile())?.goalWeight).toBe(155));
  });
});

describe('progressStore — setStartAndGoalWeight', () => {
  it('writes both fields in a single profile save', async () => {
    const { startWeight, goalWeight, setStartAndGoalWeight } = await load();
    const { getProfile } = await import('$lib/domain/health-data-storage');
    setStartAndGoalWeight(210, 160);
    expect(get(startWeight)).toBe(210);
    expect(get(goalWeight)).toBe(160);
    expect(localStorage.getItem(START_KEY)).toBe('210');
    expect(localStorage.getItem(GOAL_KEY)).toBe('160');
    await vi.waitFor(async () => {
      const profile = await getProfile();
      expect(profile?.startWeight).toBe(210);
      expect(profile?.goalWeight).toBe(160);
    });
  });

  it('clears both fields when passed nulls', async () => {
    const { startWeight, goalWeight, setStartAndGoalWeight } = await load();
    const { getProfile } = await import('$lib/domain/health-data-storage');
    setStartAndGoalWeight(210, 160);
    await vi.waitFor(async () => expect((await getProfile())?.startWeight).toBe(210));
    setStartAndGoalWeight(null, null);
    expect(get(startWeight)).toBeNull();
    expect(get(goalWeight)).toBeNull();
    await vi.waitFor(async () => {
      const profile = await getProfile();
      expect(profile?.startWeight).toBeUndefined();
      expect(profile?.goalWeight).toBeUndefined();
    });
  });
});

describe('progressStore — currentWeight', () => {
  it('is null when latestWeightLbs is null', async () => {
    latestWeightLbs.set(null);
    const { currentWeight } = await load();
    expect(get(currentWeight)).toBeNull();
  });

  it('mirrors latestWeightLbs and updates reactively', async () => {
    latestWeightLbs.set(175);
    const { currentWeight } = await load();
    expect(get(currentWeight)).toBe(175);
    latestWeightLbs.set(170);
    expect(get(currentWeight)).toBe(170);
    latestWeightLbs.set(null);
    expect(get(currentWeight)).toBeNull();
  });
});

describe('progressStore — setStartWeightIfUnset', () => {
  it('seeds startWeight (and the profile) when none is set', async () => {
    const { startWeight, setStartWeightIfUnset } = await load();
    const { getProfile } = await import('$lib/domain/health-data-storage');
    await setStartWeightIfUnset(212.4);
    expect(get(startWeight)).toBe(212.4);
    await vi.waitFor(async () => expect((await getProfile())?.startWeight).toBe(212.4));
  });

  it('leaves an existing profile startWeight untouched', async () => {
    const { setStartWeightIfUnset } = await load();
    const { saveProfile, getProfile } = await import('$lib/domain/health-data-storage');
    await saveProfile({ startWeight: 198 });
    await setStartWeightIfUnset(212.4);
    const profile = await getProfile();
    expect(profile?.startWeight).toBe(198);
  });

  it('ignores null and non-finite inputs', async () => {
    const { startWeight, setStartWeightIfUnset } = await load();
    await setStartWeightIfUnset(null);
    await setStartWeightIfUnset(Number.NaN);
    expect(get(startWeight)).toBeNull();
  });
});

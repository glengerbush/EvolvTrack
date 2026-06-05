import { browser } from '$app/environment';
import { liveQuery } from 'dexie';
import { writable, derived, get } from 'svelte/store';
import { db } from '$lib/db/schema';
import { getProfile, saveProfile } from '$lib/domain/repo';
import type { ProfileSettings } from '$lib/domain/types';
import { latestWeightLbs } from '$lib/stores/healthStore';

// Start and goal weight live on the synced `profile` row (`saveProfile` stamps
// the per-field LWW clock and enqueues the outbox push), so they propagate
// across a user's devices like every other setting. localStorage is kept only
// as a synchronous first-paint cache — and as a one-time migration source for
// accounts created before these values moved onto the profile.
const START_KEY = 'evolvtrack-start-weight';
const GOAL_KEY = 'evolvtrack-goal-weight';

function cachedNum(key: string): number | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(key);
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function writeCache(key: string, v: number | null) {
  if (typeof window === 'undefined') return;
  if (v === null) localStorage.removeItem(key);
  else localStorage.setItem(key, String(v));
}

function asNumber(v: number | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

const _startWeight = writable<number | null>(cachedNum(START_KEY));
const _goalWeight = writable<number | null>(cachedNum(GOAL_KEY));

/**
 * Reflect the profile's start/goal weight into the in-memory stores. For each
 * field, if the profile has no value yet but a legacy localStorage value
 * exists, migrate that value up via `saveProfile` (which re-fires this query
 * with the field set, converging on a no-op). Otherwise the profile is the
 * source of truth and we mirror it into the cache.
 */
function hydrateFromProfile(profile: ProfileSettings | undefined): void {
  const migrate: Partial<Pick<ProfileSettings, 'startWeight' | 'goalWeight'>> = {};

  const profileStart = asNumber(profile?.startWeight);
  const cachedStart = cachedNum(START_KEY);
  if (profileStart == null && cachedStart != null) {
    migrate.startWeight = cachedStart;
    _startWeight.set(cachedStart);
  } else {
    _startWeight.set(profileStart);
    writeCache(START_KEY, profileStart);
  }

  const profileGoal = asNumber(profile?.goalWeight);
  const cachedGoal = cachedNum(GOAL_KEY);
  if (profileGoal == null && cachedGoal != null) {
    migrate.goalWeight = cachedGoal;
    _goalWeight.set(cachedGoal);
  } else {
    _goalWeight.set(profileGoal);
    writeCache(GOAL_KEY, profileGoal);
  }

  if (migrate.startWeight != null || migrate.goalWeight != null) {
    void saveProfile(migrate);
  }
}

// `liveQuery` re-fires whenever `db.profile` changes — initial load, local
// edits via `saveProfile`, and remote-pull merges all flow through here, so the
// progress card stays in sync across tabs and across devices on the same
// account.
if (browser) {
  liveQuery(() => db.profile.get('profile')).subscribe({
    next: hydrateFromProfile,
    error: (e) => console.error('progressStore liveQuery error:', e),
  });
}

function normalize(v: number | null): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

// Mirror a value into its in-memory store + cache, returning the profile patch
// for it. `undefined` clears the profile field (and its LWW stamp records the
// clear), so a cleared value doesn't resurrect on the next pull.
function stage(
  store: typeof _startWeight,
  key: string,
  field: 'startWeight' | 'goalWeight',
  v: number | null,
): Partial<Pick<ProfileSettings, 'startWeight' | 'goalWeight'>> {
  const val = normalize(v);
  store.set(val);
  writeCache(key, val);
  return { [field]: val ?? undefined };
}

function persistedWeight(
  store: typeof _startWeight,
  key: string,
  field: 'startWeight' | 'goalWeight',
) {
  return {
    subscribe: store.subscribe,
    set(v: number | null) {
      void saveProfile(stage(store, key, field, v));
    },
  };
}

export const startWeight = persistedWeight(_startWeight, START_KEY, 'startWeight');
export const goalWeight = persistedWeight(_goalWeight, GOAL_KEY, 'goalWeight');

/**
 * Save start and goal weight together in a single profile write. The progress
 * card commits both at once; folding them into one `saveProfile` avoids two
 * back-to-back transactions racing on the same profile row.
 */
export function setStartAndGoalWeight(startLbs: number | null, goalLbs: number | null): void {
  const patch = {
    ...stage(_startWeight, START_KEY, 'startWeight', startLbs),
    ...stage(_goalWeight, GOAL_KEY, 'goalWeight', goalLbs),
  };
  void saveProfile(patch);
}

export const currentWeight = derived(latestWeightLbs, ($latest) => $latest);

/**
 * Seed the start weight from the earliest weigh-in, but only when the user
 * hasn't set one yet. Checks the synced profile (not just the in-memory store)
 * so an import on a fresh device doesn't clobber a start weight already chosen
 * on another device and pulled down.
 */
export async function setStartWeightIfUnset(lbs: number | null): Promise<void> {
  if (lbs == null || !Number.isFinite(lbs)) return;
  if (get(_startWeight) != null) return;
  const profile = await getProfile();
  if (asNumber(profile?.startWeight) != null) return;
  startWeight.set(lbs);
}

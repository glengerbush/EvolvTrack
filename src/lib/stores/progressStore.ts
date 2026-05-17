import { writable, derived, get } from 'svelte/store';
import { latestWeightLbs } from '$lib/stores/healthStore';

const START_KEY = 'evolvtrack-start-weight';
const GOAL_KEY = 'evolvtrack-goal-weight';

function getNum(key: string): number | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(key);
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function persistedWeight(key: string) {
  const store = writable<number | null>(getNum(key));
  return {
    subscribe: store.subscribe,
    set(v: number | null) {
      if (typeof window !== 'undefined') {
        if (v === null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(v));
      }
      store.set(v);
    },
  };
}

export const startWeight = persistedWeight(START_KEY);
export const goalWeight = persistedWeight(GOAL_KEY);

export const currentWeight = derived(latestWeightLbs, ($latest) => $latest);

export function setStartWeightIfUnset(lbs: number | null) {
  if (lbs == null || !Number.isFinite(lbs)) return;
  if (get(startWeight) != null) return;
  startWeight.set(lbs);
}

import { writable } from 'svelte/store';

/** Whether the medication table's remaining column shows whole doses or mg. */
export type VialUnit = 'doses' | 'mg';

const STORAGE_KEY = 'evolvtrack-vial-unit';

function getInitial(): VialUnit {
  if (typeof window === 'undefined') return 'doses';
  try {
    return localStorage.getItem(STORAGE_KEY) === 'mg' ? 'mg' : 'doses';
  } catch {
    return 'doses';
  }
}

const _vialUnit = writable<VialUnit>(getInitial());

// A per-device view preference (not synced) — the column is the same data
// either way, just a different unit.
export const vialUnit = {
  subscribe: _vialUnit.subscribe,
  set(unit: VialUnit) {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, unit);
      } catch {
        // localStorage unavailable — the choice lasts the session.
      }
    }
    _vialUnit.set(unit);
  },
  toggle() {
    _vialUnit.update((u) => {
      const next: VialUnit = u === 'doses' ? 'mg' : 'doses';
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // ignore
        }
      }
      return next;
    });
  },
};

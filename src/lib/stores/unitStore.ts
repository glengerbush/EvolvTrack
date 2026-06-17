import { writable } from 'svelte/store';
import { getProfile, saveProfile } from '$lib/domain/repo';
import { KG_PER_LB } from '$lib/utils/pharmacokinetics';
import type { WeightUnit } from '$lib/domain/types';

export type { WeightUnit };

const STORAGE_KEY = 'evolvtrack-weight-unit';

function isValidUnit(v: string | null | undefined): v is WeightUnit {
  return v === 'lbs' || v === 'kg';
}

function getInitial(): WeightUnit {
  if (typeof window === 'undefined') return 'lbs';
  return localStorage.getItem(STORAGE_KEY) === 'kg' ? 'kg' : 'lbs';
}

const _weightUnit = writable<WeightUnit>(getInitial());

if (typeof window !== 'undefined') {
  void getProfile().then((profile) => {
    if (isValidUnit(profile?.weightUnit)) {
      localStorage.setItem(STORAGE_KEY, profile.weightUnit);
      _weightUnit.set(profile.weightUnit);
    }
  });
}

export const weightUnit = {
  subscribe: _weightUnit.subscribe,
  set(unit: WeightUnit) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, unit);
    }
    _weightUnit.set(unit);
    void saveProfile({ weightUnit: unit });
  },
};

/** Convert an internally-stored lbs string to the display unit. */
export function displayWeight(lbsStr: string, unit: WeightUnit): string {
  if (!lbsStr) return '';
  const n = parseFloat(lbsStr);
  if (!isFinite(n)) return lbsStr;
  if (unit === 'kg') return (n * KG_PER_LB).toFixed(1);
  return n % 1 === 0 ? String(n) : parseFloat(n.toFixed(1)).toString();
}

/** Convert a value entered in the display unit back to lbs for storage. */
export function toStoredLbs(inputStr: string, unit: WeightUnit): string {
  if (!inputStr) return '';
  const n = parseFloat(inputStr);
  if (!isFinite(n)) return inputStr;
  if (unit === 'kg') return String(n / KG_PER_LB);
  return inputStr;
}

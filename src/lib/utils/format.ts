import type { WeightUnit } from '$lib/stores/unitStore';

/** Max decimal places (up to `max`) actually used across a set of numbers. */
export function columnDecimals(values: number[], max = 2): number {
  let places = 0;
  for (const n of values) {
    if (!Number.isFinite(n)) continue;
    const str = String(n);
    const dot = str.indexOf('.');
    if (dot !== -1) {
      places = Math.max(places, Math.min(str.length - dot - 1, max));
    }
    if (places >= max) break;
  }
  return places;
}

/** Format a finite number to exactly `decimals` places; empty string for non-finite. */
export function fmtNum(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(decimals);
}

/** Convert a stored-lbs string to the display unit as a number (NaN if invalid). */
export function lbsToDisplayNum(lbsStr: string, unit: WeightUnit): number {
  const n = parseFloat(lbsStr);
  if (!isFinite(n)) return NaN;
  return unit === 'kg' ? n * 0.453592 : n;
}

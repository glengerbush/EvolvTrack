import type { IsoDate } from '$lib/domain/types';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Type-guard: narrows a `string` to a branded `IsoDate` if it matches the
 * `YYYY-MM-DD` shape and the parsed components round-trip (e.g. month 13 is
 * rejected, even though `new Date(...)` would silently roll it over).
 */
export function isDateKey(dateKey: string): dateKey is IsoDate {
  return parseDateKey(dateKey) !== null;
}

/** Validator: returns the branded `IsoDate` if valid, otherwise `null`. */
export function asIsoDate(dateKey: string): IsoDate | null {
  return isDateKey(dateKey) ? dateKey : null;
}

/**
 * Parse an `IsoDate`-shaped string into a `Date` at local midnight. Returns
 * `null` if the input is malformed or contains overflow values. Accepts a raw
 * string so it can act as the entry-point validator.
 */
export function parseDateKey(dateKey: string): Date | null {
  const match = ISO_DATE_RE.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function dateKeyFromDate(date: Date): IsoDate {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}` as IsoDate;
}

export function localDateKey(date: Date = new Date()): IsoDate {
  return dateKeyFromDate(date);
}

export function addDays(dateKey: IsoDate, days: number): IsoDate {
  const date = parseDateKey(dateKey) ?? new Date();
  date.setDate(date.getDate() + days);
  return dateKeyFromDate(date);
}

export function daysBetween(startDate: IsoDate, endDate: IsoDate): number {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate);
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

export function enumerateDateKeys(startDate: IsoDate, endDate: IsoDate): IsoDate[] {
  const days = Math.max(daysBetween(startDate, endDate), 0);
  return Array.from({ length: days + 1 }, (_, index) => addDays(startDate, index));
}

export function minDateKey(dates: (IsoDate | string | null | undefined)[]): IsoDate | null {
  const valid = dates.filter((d): d is IsoDate => typeof d === 'string' && isDateKey(d));
  return valid.length ? valid.reduce((min, d) => (d < min ? d : min), valid[0]) : null;
}

export function maxDateKey(dates: (IsoDate | string | null | undefined)[]): IsoDate | null {
  const valid = dates.filter((d): d is IsoDate => typeof d === 'string' && isDateKey(d));
  return valid.length ? valid.reduce((max, d) => (d > max ? d : max), valid[0]) : null;
}

export function formatShortDate(dateKey: string): string {
  const date = parseDateKey(dateKey);
  if (!date) return dateKey;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

const localeDateFormatter = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
  : null;

/**
 * Render an ISO date key using the user's locale, matching the format the
 * native `<input type="date">` displays (e.g. `05/10/2026` in en-US).
 */
export function formatLocaleDate(dateKey: string | null | undefined): string {
  if (!dateKey) return '';
  const date = parseDateKey(dateKey);
  if (!date) return dateKey;
  return localeDateFormatter?.format(date) ?? dateKey;
}

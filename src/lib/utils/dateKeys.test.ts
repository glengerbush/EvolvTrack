import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import {
  addDays,
  asIsoDate,
  dateKeyFromDate,
  daysBetween,
  enumerateDateKeys,
  formatLocaleDate,
  formatShortDate,
  isDateKey,
  localDateKey,
  maxDateKey,
  minDateKey,
  parseDateKey,
} from './dateKeys';

describe('isDateKey', () => {
  it.each([
    ['2026-05-10', true],
    ['2026-1-1', false], // requires 2-digit month/day
    ['2026/05/10', false],
    ['', false],
    ['not-a-date', false],
  ])('isDateKey(%s) === %s', (input, expected) => {
    expect(isDateKey(input)).toBe(expected);
  });

  // parseDateKey rejects components that would roll over into another month
  // or year (e.g. month 13, day 30 of February).
  it.each([
    ['2026-13-01', false], // month 13
    ['2026-00-01', false], // month 0
    ['2026-02-30', false], // Feb 30 → Mar 2
    ['2027-02-29', false], // 2027 is not a leap year
    ['2028-02-29', true],  // 2028 is a leap year
  ])('isDateKey(%s) === %s (overflow rejection)', (input, expected) => {
    expect(isDateKey(input)).toBe(expected);
  });
});

describe('asIsoDate', () => {
  it('returns the branded string for valid input', () => {
    expect(asIsoDate('2026-05-10')).toBe('2026-05-10');
  });

  it('returns null for invalid input', () => {
    expect(asIsoDate('bad')).toBeNull();
    expect(asIsoDate('2026-13-01')).toBeNull();
    expect(asIsoDate('')).toBeNull();
  });
});

describe('parseDateKey', () => {
  it('parses an ISO date key at local midnight', () => {
    const date = parseDateKey('2026-05-10');
    expect(date).not.toBeNull();
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(4); // 0-indexed: May = 4
    expect(date!.getDate()).toBe(10);
    expect(date!.getHours()).toBe(0);
  });

  it('returns null for malformed inputs', () => {
    expect(parseDateKey('2026-5-10')).toBeNull();
    expect(parseDateKey('05/10/2026')).toBeNull();
    expect(parseDateKey('')).toBeNull();
  });
});

describe('dateKeyFromDate / localDateKey round trip', () => {
  it('round trips through parseDateKey', () => {
    const key = iso('2026-05-10');
    const date = parseDateKey(key);
    expect(dateKeyFromDate(date!)).toBe(key);
  });

  it('localDateKey returns YYYY-MM-DD for "now"', () => {
    const key = localDateKey();
    expect(isDateKey(key)).toBe(true);
  });

  it('localDateKey respects a passed-in Date', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('addDays', () => {
  it('adds and subtracts days correctly across month boundaries', () => {
    expect(addDays(iso('2026-01-31'), 1)).toBe('2026-02-01');
    expect(addDays(iso('2026-03-01'), -1)).toBe('2026-02-28');
  });

  it('handles year boundaries', () => {
    expect(addDays(iso('2025-12-31'), 1)).toBe('2026-01-01');
    expect(addDays(iso('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('handles leap years', () => {
    expect(addDays(iso('2028-02-28'), 1)).toBe('2028-02-29');
    expect(addDays(iso('2028-02-29'), 1)).toBe('2028-03-01');
  });
});

describe('daysBetween', () => {
  it('returns the integer day count between two date keys', () => {
    expect(daysBetween(iso('2026-05-10'), iso('2026-05-15'))).toBe(5);
    expect(daysBetween(iso('2026-05-15'), iso('2026-05-10'))).toBe(-5);
    expect(daysBetween(iso('2026-05-10'), iso('2026-05-10'))).toBe(0);
  });
});

describe('enumerateDateKeys', () => {
  it('returns an inclusive range from start to end', () => {
    expect(enumerateDateKeys(iso('2026-05-10'), iso('2026-05-13'))).toEqual([
      '2026-05-10',
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
    ]);
  });

  it('returns a single date when start equals end', () => {
    expect(enumerateDateKeys(iso('2026-05-10'), iso('2026-05-10'))).toEqual(['2026-05-10']);
  });

  it('clamps to a single date when end is before start', () => {
    expect(enumerateDateKeys(iso('2026-05-15'), iso('2026-05-10'))).toEqual(['2026-05-15']);
  });
});

describe('minDateKey / maxDateKey', () => {
  it('returns the smallest/largest valid date key', () => {
    const dates = ['2026-05-10', '2026-01-01', '2026-12-31'];
    expect(minDateKey(dates)).toBe('2026-01-01');
    expect(maxDateKey(dates)).toBe('2026-12-31');
  });

  it('ignores null/undefined/invalid entries', () => {
    expect(minDateKey([null, undefined, 'bad', '2026-05-10'])).toBe('2026-05-10');
    expect(maxDateKey([null, undefined, 'bad', '2026-05-10'])).toBe('2026-05-10');
  });

  it('returns null when no valid date is present', () => {
    expect(minDateKey([])).toBeNull();
    expect(minDateKey([null, undefined, 'bad'])).toBeNull();
    expect(maxDateKey([])).toBeNull();
  });
});

describe('formatShortDate', () => {
  it('renders as M/D without padding or year', () => {
    expect(formatShortDate('2026-05-10')).toBe('5/10');
    expect(formatShortDate('2026-01-05')).toBe('1/5');
  });

  it('passes through malformed inputs unchanged', () => {
    expect(formatShortDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatLocaleDate', () => {
  it('returns the empty string for falsy input', () => {
    expect(formatLocaleDate('')).toBe('');
    expect(formatLocaleDate(null)).toBe('');
    expect(formatLocaleDate(undefined)).toBe('');
  });

  it('passes malformed dates through unchanged', () => {
    expect(formatLocaleDate('bad')).toBe('bad');
  });

  it('formats a valid date in the user locale with 2-digit month/day', () => {
    const result = formatLocaleDate('2026-05-10');
    expect(result).toContain('05');
    expect(result).toContain('10');
    expect(result).toContain('2026');
    expect(result).not.toBe('2026-05-10');
  });
});

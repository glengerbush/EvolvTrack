import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import {
  calculateSystemMg,
  calculateSystemMgByDrug,
  drugDisplayColor,
  drugInitial,
  formatSystemMg,
} from './pharmacokinetics';

const SEMA = 'Semaglutide (Ozempic / Wegovy)';
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';

describe('calculateSystemMgByDrug', () => {
  it('returns [] when there are no injections', () => {
    expect(calculateSystemMgByDrug([], iso('2026-01-01'))).toEqual([]);
  });

  it('a same-day injection contributes 0 to its own day (same-day-zero rule)', () => {
    // The PK model evaluates residual at 00:00 of targetDate, just before that
    // day's dose is administered. Documented in pharmacokinetics.ts:119.
    const result = calculateSystemMgByDrug(
      [{ date: iso('2026-01-01'), amountMg: 5, medication: SEMA }],
      iso('2026-01-01'),
    );
    expect(result).toEqual([]);
  });

  it('a future-dated injection contributes 0 (tHours < 0 is filtered out)', () => {
    const result = calculateSystemMgByDrug(
      [{ date: iso('2026-01-10'), amountMg: 5, medication: SEMA }],
      iso('2026-01-01'),
    );
    expect(result).toEqual([]);
  });

  it('produces a positive residual the day after a single dose', () => {
    const result = calculateSystemMgByDrug(
      [{ date: iso('2026-01-01'), amountMg: 5, medication: SEMA }],
      iso('2026-01-02'),
    );
    expect(result).toHaveLength(1);
    expect(result[0].medication).toBe(SEMA);
    expect(result[0].amountMg).toBeGreaterThan(0);
    expect(result[0].amountMg).toBeLessThan(5); // bioavailability < 1
  });

  it('residual decays after Tmax has passed (semaglutide: ~3 days)', () => {
    // Tmax for the two-compartment semaglutide model is ~75h ≈ 3 days; values
    // should descend strictly after that point.
    const dose = [{ date: iso('2026-01-01'), amountMg: 5, medication: SEMA }];
    const day5 = calculateSystemMgByDrug(dose, iso('2026-01-05'))[0].amountMg;
    const day8 = calculateSystemMgByDrug(dose, iso('2026-01-08'))[0].amountMg;
    const day15 = calculateSystemMgByDrug(dose, iso('2026-01-15'))[0].amountMg;
    expect(day5).toBeGreaterThan(day8);
    expect(day8).toBeGreaterThan(day15);
    expect(day15).toBeGreaterThan(0);
  });

  it('keeps separate totals per medication when both are present', () => {
    const result = calculateSystemMgByDrug(
      [
        { date: iso('2026-01-01'), amountMg: 5, medication: SEMA },
        { date: iso('2026-01-01'), amountMg: 10, medication: TIRZ },
      ],
      iso('2026-01-05'),
    );
    expect(result).toHaveLength(2);
    const byMed = Object.fromEntries(result.map((r) => [r.medication, r.amountMg]));
    expect(byMed[SEMA]).toBeGreaterThan(0);
    expect(byMed[TIRZ]).toBeGreaterThan(0);
  });

  it('accumulates same-drug doses across multiple administrations', () => {
    const single = calculateSystemMgByDrug(
      [{ date: iso('2026-01-01'), amountMg: 5, medication: SEMA }],
      iso('2026-01-15'),
    )[0].amountMg;
    const double = calculateSystemMgByDrug(
      [
        { date: iso('2026-01-01'), amountMg: 5, medication: SEMA },
        { date: iso('2026-01-08'), amountMg: 5, medication: SEMA },
      ],
      iso('2026-01-15'),
    )[0].amountMg;
    expect(double).toBeGreaterThan(single);
  });

  it('skips injections with an unknown medication', () => {
    const result = calculateSystemMgByDrug(
      [
        { date: iso('2026-01-01'), amountMg: 5, medication: 'NotARealDrug' },
        { date: iso('2026-01-01'), amountMg: 5, medication: SEMA },
      ],
      iso('2026-01-05'),
    );
    expect(result).toHaveLength(1);
    expect(result[0].medication).toBe(SEMA);
  });

  it('omits drugs whose rounded residual is 0', () => {
    // 1 microgram of semaglutide a year later rounds to 0.
    const result = calculateSystemMgByDrug(
      [{ date: iso('2026-01-01'), amountMg: 0.001, medication: SEMA }],
      iso('2027-01-01'),
    );
    expect(result).toEqual([]);
  });
});

describe('calculateSystemMg (summed total)', () => {
  it('returns the sum across all drugs at the target date', () => {
    const injections = [
      { date: iso('2026-01-01'), amountMg: 5, medication: SEMA },
      { date: iso('2026-01-01'), amountMg: 10, medication: TIRZ },
    ];
    const byDrug = calculateSystemMgByDrug(injections, iso('2026-01-05'));
    const expected = byDrug.reduce((sum, r) => sum + r.amountMg, 0);
    expect(calculateSystemMg(injections, iso('2026-01-05'))).toBeCloseTo(expected, 1);
  });

  it('returns 0 for an empty injection list', () => {
    expect(calculateSystemMg([], iso('2026-01-01'))).toBe(0);
  });
});

describe('formatSystemMg', () => {
  it('rounds to 2 decimal places and returns a string', () => {
    expect(formatSystemMg(1.234567)).toBe('1.23');
    expect(formatSystemMg(0)).toBe('0');
    expect(formatSystemMg(10)).toBe('10');
  });
});

describe('drugInitial', () => {
  it('returns the uppercase first character of the medication name', () => {
    expect(drugInitial(SEMA)).toBe('S');
    expect(drugInitial('tirzepatide')).toBe('T');
  });

  it('falls back to "?" for empty input', () => {
    expect(drugInitial('')).toBe('?');
    expect(drugInitial('   ')).toBe('?');
  });
});

describe('drugDisplayColor', () => {
  it('returns the themed CSS variable for a known medication', () => {
    expect(drugDisplayColor(SEMA)).toBe('var(--drug-sema)');
    expect(drugDisplayColor(TIRZ)).toBe('var(--drug-tirz)');
  });

  it('is deterministic for unknown medications (same input → same color)', () => {
    const a = drugDisplayColor('Mystery Compound');
    const b = drugDisplayColor('Mystery Compound');
    expect(a).toBe(b);
  });
});

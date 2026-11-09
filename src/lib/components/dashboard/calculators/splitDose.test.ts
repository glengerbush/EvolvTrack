import { describe, expect, it } from 'vitest';
import { formatSplitDose, intervalDose, twiceWeeklyDoses } from './splitDose';

describe('split dosing', () => {
  it.each([0.5, 1, 3.5, 7, 10, 30])('preserves the weekly average every %s days', (days) => {
    expect(intervalDose(7, days)).toBe(days);
    expect(intervalDose(5, days)! * 7 / days).toBeCloseTo(5);
  });

  it('weights doses by the gap until the next selected weekday', () => {
    expect(twiceWeeklyDoses(7, [0, 3])).toEqual([
      { day: 0, daysUntilNext: 3, doseMg: 3 },
      { day: 3, daysUntilNext: 4, doseMg: 4 }
    ]);
  });

  it('handles Sunday/Monday wrap without changing the selection', () => {
    const days = [6, 0];
    expect(twiceWeeklyDoses(7, days)).toEqual([
      { day: 0, daysUntilNext: 6, doseMg: 6 },
      { day: 6, daysUntilNext: 1, doseMg: 1 }
    ]);
    expect(days).toEqual([6, 0]);
  });

  it('preserves the weekly total for every pair of weekdays', () => {
    for (let first = 0; first < 7; first++) {
      for (let second = first + 1; second < 7; second++) {
        const doses = twiceWeeklyDoses(2.5, [first, second])!;
        expect(doses.reduce((total, dose) => total + dose.doseMg, 0)).toBeCloseTo(2.5);
        expect(doses.reduce((total, dose) => total + dose.daysUntilNext, 0)).toBe(7);
      }
    }
  });

  it.each([[], [0], [0, 0], [0, 7], [-1, 3], [0.5, 3], [0, 3, 6]])('rejects invalid selected days %j', (...days) => {
    expect(twiceWeeklyDoses(5, days)).toBeNull();
  });

  it.each([undefined, 0, -5, NaN, Infinity])('rejects invalid weekly amount %s', (value) => {
    expect(intervalDose(value, 5)).toBeNull();
    expect(twiceWeeklyDoses(value, [0, 3])).toBeNull();
  });

  it.each([undefined, 0, -1, NaN, Infinity])('rejects invalid frequency %s', (value) => {
    expect(intervalDose(5, value)).toBeNull();
  });

  it('suppresses results outside the numeric range', () => {
    expect(intervalDose(Number.MAX_VALUE, 100)).toBeNull();
    expect(intervalDose(Number.MIN_VALUE, 1)).toBeNull();
    expect(twiceWeeklyDoses(Number.MIN_VALUE, [0, 3])).toBeNull();
  });

  it('does not display tiny positive amounts as zero', () => {
    expect(formatSplitDose(0.001)).toBe('<0.01');
    expect(formatSplitDose(5 / 7 * 3)).toBe('2.14');
  });
});

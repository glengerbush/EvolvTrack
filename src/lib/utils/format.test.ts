import { describe, expect, it } from 'vitest';
import { columnDecimals, fmtNum, lbsToDisplayNum } from './format';

describe('columnDecimals', () => {
  it('returns 0 when every value is an integer', () => {
    expect(columnDecimals([1, 2, 3])).toBe(0);
  });

  it('returns 0 for an empty array', () => {
    expect(columnDecimals([])).toBe(0);
  });

  it('uses the maximum number of decimals seen, up to `max`', () => {
    expect(columnDecimals([1, 2.5, 3])).toBe(1);
    expect(columnDecimals([1.2, 2.34])).toBe(2);
  });

  it('clamps to the default max of 2 even if a value has more decimals', () => {
    expect(columnDecimals([1.234567])).toBe(2);
  });

  it('honors a custom `max` argument', () => {
    expect(columnDecimals([1.234567], 4)).toBe(4);
    expect(columnDecimals([1.2], 0)).toBe(0);
  });

  it('ignores non-finite values', () => {
    expect(columnDecimals([NaN, Infinity, -Infinity, 1.5])).toBe(1);
    expect(columnDecimals([NaN, Infinity])).toBe(0);
  });

  it.each([
    [[1, 2, 3], 0],
    [[1.5], 1],
    [[1.55], 2],
    [[1, 2.5, 3.55], 2],
  ])('columnDecimals(%j) === %i', (input, expected) => {
    expect(columnDecimals(input)).toBe(expected);
  });

  it('short-circuits once `max` is reached (does not throw on huge arrays)', () => {
    const huge = [1.23, ...Array.from({ length: 100000 }, (_, i) => i)];
    expect(columnDecimals(huge)).toBe(2);
  });
});

describe('fmtNum', () => {
  it('formats finite numbers to the requested decimal count', () => {
    expect(fmtNum(1, 2)).toBe('1.00');
    expect(fmtNum(1.234, 2)).toBe('1.23');
    expect(fmtNum(1.235, 2)).toBe('1.24');
    expect(fmtNum(1.5, 0)).toBe('2');
  });

  it('returns empty string for non-finite inputs', () => {
    expect(fmtNum(NaN, 2)).toBe('');
    expect(fmtNum(Infinity, 2)).toBe('');
    expect(fmtNum(-Infinity, 2)).toBe('');
  });

  it('handles zero and negative numbers', () => {
    expect(fmtNum(0, 2)).toBe('0.00');
    expect(fmtNum(-1.5, 1)).toBe('-1.5');
  });
});

describe('lbsToDisplayNum', () => {
  it('returns the parsed number unchanged when unit is lbs', () => {
    expect(lbsToDisplayNum('150', 'lbs')).toBe(150);
    expect(lbsToDisplayNum('150.5', 'lbs')).toBe(150.5);
  });

  it('converts lbs to kg when unit is kg', () => {
    expect(lbsToDisplayNum('100', 'kg')).toBeCloseTo(45.3592, 4);
    expect(lbsToDisplayNum('220.46', 'kg')).toBeCloseTo(100, 2);
  });

  it('returns NaN for non-numeric input', () => {
    expect(lbsToDisplayNum('', 'lbs')).toBeNaN();
    expect(lbsToDisplayNum('abc', 'lbs')).toBeNaN();
    expect(lbsToDisplayNum('', 'kg')).toBeNaN();
  });

  it('parseFloat semantics: accepts leading numeric prefix', () => {
    // parseFloat('150lbs') === 150 — documenting current behavior.
    expect(lbsToDisplayNum('150lbs', 'lbs')).toBe(150);
  });
});

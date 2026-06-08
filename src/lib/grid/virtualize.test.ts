import { describe, expect, it } from 'vitest';
import { buildPrefix, computeVisibleRange, indexAtOffset } from './virtualize';

describe('buildPrefix', () => {
  it('produces cumulative offsets with a leading 0', () => {
    expect(buildPrefix([10, 20, 5])).toEqual([0, 10, 30, 35]);
  });
  it('handles empty input', () => {
    expect(buildPrefix([])).toEqual([0]);
  });
});

describe('indexAtOffset', () => {
  const prefix = buildPrefix([10, 10, 10, 10]); // [0,10,20,30,40]
  it('finds the row containing an offset', () => {
    expect(indexAtOffset(prefix, 0, 4)).toBe(0);
    expect(indexAtOffset(prefix, 9, 4)).toBe(0);
    expect(indexAtOffset(prefix, 10, 4)).toBe(1);
    expect(indexAtOffset(prefix, 25, 4)).toBe(2);
  });
  it('clamps at the ends', () => {
    expect(indexAtOffset(prefix, -5, 4)).toBe(0);
    expect(indexAtOffset(prefix, 9999, 4)).toBe(4);
  });
});

describe('computeVisibleRange', () => {
  // 10 rows of height 10 → prefix [0,10,...,100].
  const prefix = buildPrefix(Array(10).fill(10));

  it('returns the overscanned window for a mid-scroll position', () => {
    // scrolled past 30px, viewport 20px tall (bottomFromTop = 50), overscan 2.
    const r = computeVisibleRange(prefix, 10, 30, 50, 2);
    expect(r.first).toBe(1); // indexAtOffset(30)=3, −2 overscan
    expect(r.last).toBe(7); // indexAtOffset(50)=5, +2 overscan
    expect(r.topSpacer).toBe(prefix[1]);
    expect(r.bottomSpacer).toBe(prefix[10] - prefix[8]);
  });

  it('clamps the window to the row range', () => {
    const r = computeVisibleRange(prefix, 10, 0, 1000, 2);
    expect(r.first).toBe(0);
    expect(r.last).toBe(9);
    expect(r.topSpacer).toBe(0);
    expect(r.bottomSpacer).toBe(0);
  });

  it('is empty-safe', () => {
    expect(computeVisibleRange([0], 0, 0, 100, 2)).toEqual({
      first: 0,
      last: 0,
      topSpacer: 0,
      bottomSpacer: 0,
    });
  });
});

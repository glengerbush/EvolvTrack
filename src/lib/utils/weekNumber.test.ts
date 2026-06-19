import { describe, it, expect } from 'vitest';
import { computeWeekCells, weekNumberFor } from './weekNumber';
import { iso } from '../../test/iso';

describe('weekNumberFor', () => {
  it('counts rolling 7-day blocks from the anchor (anchor day is week 1)', () => {
    const anchor = iso('2026-06-02');
    expect(weekNumberFor('2026-06-02', anchor)).toBe(1); // day 0
    expect(weekNumberFor('2026-06-08', anchor)).toBe(1); // day 6
    expect(weekNumberFor('2026-06-09', anchor)).toBe(2); // day 7
    expect(weekNumberFor('2026-06-15', anchor)).toBe(2); // day 13
    expect(weekNumberFor('2026-06-16', anchor)).toBe(3); // day 14
  });

  it('returns null for an invalid / empty date', () => {
    expect(weekNumberFor('', iso('2026-06-02'))).toBeNull();
    expect(weekNumberFor('not-a-date', iso('2026-06-02'))).toBeNull();
  });
});

describe('computeWeekCells', () => {
  it('anchors on the earliest valid date regardless of display order', () => {
    // Display order is newest-first; anchor is still the earliest (Jun 2).
    const cells = computeWeekCells(['2026-06-16', '2026-06-09', '2026-06-02']);
    expect(cells.map((c) => c.week)).toEqual([3, 2, 1]);
  });

  it('marks the first, last, and centred label row of each contiguous block', () => {
    // Three rows in week 2, two in week 1 (display order newest-first).
    const cells = computeWeekCells([
      '2026-06-11',
      '2026-06-10',
      '2026-06-09', // week 2 block (3 rows)
      '2026-06-03',
      '2026-06-02', // week 1 block (2 rows)
    ]);
    expect(cells.map((c) => c.week)).toEqual([2, 2, 2, 1, 1]);
    // Week 2 block: first idx0, last idx2, label centred at idx1.
    expect(cells[0]).toMatchObject({ isFirstOfWeek: true, isLastOfWeek: false, isLabelRow: false });
    expect(cells[1]).toMatchObject({ isFirstOfWeek: false, isLastOfWeek: false, isLabelRow: true });
    expect(cells[2]).toMatchObject({ isFirstOfWeek: false, isLastOfWeek: true, isLabelRow: false });
    // Week 1 block (even size): label biased to the top half (idx3).
    expect(cells[3]).toMatchObject({ isFirstOfWeek: true, isLabelRow: true });
    expect(cells[4]).toMatchObject({ isLastOfWeek: true, isLabelRow: false });
  });

  it('treats a dateless row as its own single-row block', () => {
    const cells = computeWeekCells(['2026-06-09', '', '2026-06-02']);
    expect(cells[1].week).toBeNull();
    expect(cells[0]).toMatchObject({ week: 2, isFirstOfWeek: true, isLastOfWeek: true, isLabelRow: true });
    expect(cells[2]).toMatchObject({ week: 1, isFirstOfWeek: true, isLastOfWeek: true, isLabelRow: true });
  });

  it('returns all-null when no row has a valid date', () => {
    const cells = computeWeekCells(['', 'bad']);
    expect(cells.every((c) => c.week === null && !c.isLabelRow)).toBe(true);
  });
});

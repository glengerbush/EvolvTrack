import { describe, it, expect } from 'vitest';
import { buildEfficacyRows, type EfficacyInputRow } from './efficacy';
import { iso } from '../../test/iso';

function row(date: string, weight = '', dose = '', doseSkipped = false): EfficacyInputRow {
  return { date: iso(date), weight, dose, doseSkipped };
}

describe('buildEfficacyRows', () => {
  it('returns nothing until there are at least two weigh-ins', () => {
    expect(buildEfficacyRows([row('2026-06-02', '200')])).toEqual([]);
  });

  it('anchors weeks on the earliest logged day (matching the inputs rail)', () => {
    // Earliest entry is a dose-only row on Jun 2 (week 1). Weigh-ins land in
    // week 1 (Jun 8) and week 2 (Jun 9), so they keep the rail's W#.
    const rows = buildEfficacyRows([
      row('2026-06-02', '', '2.5'),
      row('2026-06-08', '200'),
      row('2026-06-09', '198'),
    ]);
    // Newest week first.
    expect(rows.map((r) => r.week)).toEqual([2, 1]);
  });

  it('computes week-over-week loss against the previous weighed week', () => {
    const rows = buildEfficacyRows([
      row('2026-06-02', '200'), // week 1
      row('2026-06-09', '198'), // week 2
      row('2026-06-16', '195'), // week 3
    ]).reverse(); // back to ascending for readability
    expect(rows[0]).toMatchObject({ week: 1, lossLbs: null }); // no prior week
    expect(rows[1]).toMatchObject({ week: 2, lossLbs: 2 });
    expect(rows[2]).toMatchObject({ week: 3, lossLbs: 3 });
  });

  it('keeps gap weeks with dashes instead of truncating at the first gap', () => {
    // Weeks 1 and 2 have weigh-ins; week 3 has nothing; week 4 resumes.
    const rows = buildEfficacyRows([
      row('2026-06-02', '200'), // week 1
      row('2026-06-09', '198'), // week 2
      row('2026-06-23', '194'), // week 4 (week 3 is a gap)
    ]).reverse();
    expect(rows.map((r) => r.week)).toEqual([1, 2, 3, 4]);
    // Gap week 3: no weight (loss null) and no dose (empty display).
    expect(rows[2]).toMatchObject({ week: 3, lossLbs: null, doseDisplay: '' });
    // Week 4 loss is measured against week 2 (the last weighed week).
    expect(rows[3]).toMatchObject({ week: 4, lossLbs: 4 });
  });

  it('shows the week\'s last active dose and ignores skipped doses', () => {
    const rows = buildEfficacyRows([
      row('2026-06-02', '200', '2.5'),
      row('2026-06-05', '', '5'),
      row('2026-06-09', '198', '7.5', true), // skipped — not counted
    ]).reverse();
    // Week 1: last active dose is the 5 mg on Jun 5 (the 2.5 is earlier).
    expect(rows[0]).toMatchObject({ week: 1, doseDisplay: '5 mg' });
    // Week 2: only a skipped dose → dash (empty).
    expect(rows[1]).toMatchObject({ week: 2, doseDisplay: '' });
  });

  it('ends at the last week with weight or dose data', () => {
    const rows = buildEfficacyRows([
      row('2026-06-02', '200'),
      row('2026-06-09', '198'),
      row('2026-07-20', '', '', false), // a later, non-weight/non-dose entry
    ]);
    // Trailing symptom/notes-only week must not extend the table.
    expect(rows[0].week).toBe(2);
  });
});

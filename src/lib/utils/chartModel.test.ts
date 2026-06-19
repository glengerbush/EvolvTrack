import { describe, expect, it } from 'vitest';
import { SvelteSet } from 'svelte/reactivity';
import { iso } from '../../test/iso';
import type { IsoDate } from '$lib/domain/types';
import { buildChartModel, type ChartHealthRow, type GraphSeriesKey } from './chartModel';

const SEMA = 'Semaglutide (Ozempic / Wegovy)';

const TODAY = iso('2026-05-10');

/** Convenience: a row with sensible defaults; override what each test cares about. */
function row(overrides: Partial<ChartHealthRow> = {}): ChartHealthRow {
  return {
    date: TODAY,
    dose: '',
    dosePlanned: false,
    doseSkipped: false,
    medication: '',
    weight: '',
    wellness: '',
    symptoms: [],
    ...overrides,
  };
}

function build(rows: ChartHealthRow[], today: IsoDate = TODAY) {
  return buildChartModel(rows, 'lbs', {}, 180, today, new SvelteSet<GraphSeriesKey>());
}

describe('buildChartModel — skipped row contributes nothing', () => {
  const rows: ChartHealthRow[] = [
    // Several confirmed past entries so the chart has data to render around.
    row({ date: iso('2026-05-01'), weight: '180', dose: '5', medication: SEMA }),
    row({ date: iso('2026-05-08'), weight: '178', dose: '5', medication: SEMA }),
    // A row that's been skipped — weight + wellness are present, but the
    // entire row should be ignored.
    row({
      date: iso('2026-05-10'),
      weight: '177',
      wellness: '3',
      dose: '5',
      doseSkipped: true,
      medication: SEMA,
    }),
  ];

  const model = build(rows);

  it('omits the skipped row from every system-series dose marker list', () => {
    for (const series of model.systemSeries) {
      expect(series.dosePoints.find((p) => p.date === '2026-05-10')).toBeUndefined();
      expect(series.plannedDosePoints.find((p) => p.date === '2026-05-10')).toBeUndefined();
    }
  });

  it('omits the skipped row from weightPoints', () => {
    expect(model.weightPoints.find((p) => p.date === '2026-05-10')).toBeUndefined();
  });

  it('omits the skipped row from wellnessStacks (no blocks on that date)', () => {
    const stack = model.wellnessStacks.find((s) => s.date === '2026-05-10');
    expect(stack?.blocks ?? []).toHaveLength(0);
  });

  it("does not pull the chart's right edge forward to the skipped date", () => {
    expect(model.todayX).toBeNull();
  });
});

describe('buildChartModel — planned dose marker', () => {
  it('classifies a future-dated dose as planned, not confirmed', () => {
    const rows = [
      row({ date: iso('2026-05-01'), dose: '5', medication: SEMA, weight: '180' }),
      row({ date: iso('2026-05-15'), dose: '5', medication: SEMA }),
    ];
    const model = build(rows);

    const series = model.systemSeries[0];
    expect(series.plannedDosePoints.map((p) => p.date)).toContain('2026-05-15');
    expect(series.dosePoints.map((p) => p.date)).not.toContain('2026-05-15');
    expect(series.dosePoints.map((p) => p.date)).toContain('2026-05-01');
  });
});

describe('buildChartModel — same-day doses combine into one marker', () => {
  it('collapses two same-day, same-drug doses into one marker with the summed mg', () => {
    const rows = [
      row({ date: iso('2026-05-01'), dose: '5', medication: SEMA, weight: '180' }),
      // Two confirmed doses logged on the same day, same drug.
      row({ date: iso('2026-05-08'), dose: '2.5', medication: SEMA }),
      row({ date: iso('2026-05-08'), dose: '2.5', medication: SEMA }),
    ];
    const model = build(rows);
    const series = model.systemSeries[0];

    const onDate = series.dosePoints.filter((p) => p.date === '2026-05-08');
    expect(onDate).toHaveLength(1);
    expect(onDate[0].amountMg).toBe(5);
  });

  it('keeps two different drugs dosed the same day as separate markers', () => {
    const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';
    const rows = [
      row({ date: iso('2026-05-01'), dose: '5', medication: SEMA, weight: '180' }),
      row({ date: iso('2026-05-01'), dose: '10', medication: TIRZ }),
      row({ date: iso('2026-05-08'), dose: '5', medication: SEMA }),
      row({ date: iso('2026-05-08'), dose: '10', medication: TIRZ }),
    ];
    const model = build(rows);
    // Multiple drugs split into one per-drug series each; the shared date stays
    // one dot *per drug* (different curve heights), never merged across drugs.
    const semaSeries = model.systemSeries.find((s) => s.medication === SEMA);
    const tirzSeries = model.systemSeries.find((s) => s.medication === TIRZ);
    const semaDot = semaSeries?.dosePoints.filter((p) => p.date === '2026-05-08') ?? [];
    const tirzDot = tirzSeries?.dosePoints.filter((p) => p.date === '2026-05-08') ?? [];
    expect(semaDot).toHaveLength(1);
    expect(semaDot[0].amountMg).toBe(5);
    expect(tirzDot).toHaveLength(1);
    expect(tirzDot[0].amountMg).toBe(10);
  });
});

describe('buildChartModel — projection start (same-day-zero rule)', () => {
  it("a planned dose today doesn't dash the line at today", () => {
    const rows = [
      row({ date: iso('2026-05-01'), dose: '5', medication: SEMA, weight: '180' }),
      row({ date: TODAY, dose: '5', medication: SEMA, dosePlanned: true }),
    ];
    const model = build(rows);
    const series = model.systemSeries[0];

    const todayDot = series.dosePoints.find((p) => p.date === TODAY)
      ?? series.plannedDosePoints.find((p) => p.date === TODAY);
    expect(todayDot, 'a marker should exist at today').toBeDefined();

    const xToday = todayDot!.x.toFixed(1);
    expect(series.actualPath).toContain(xToday);
    expect(series.predictionPath).not.toContain(xToday);
  });
});

describe('buildChartModel — crosshairSnap (data-snapped crosshair)', () => {
  const rows = [
    row({ date: iso('2026-05-01'), weight: '180', dose: '5', medication: SEMA }),
    row({ date: iso('2026-05-08'), weight: '178', dose: '5', medication: SEMA }),
  ];

  it('snaps the left arm to that day weight and the right arm to mg in system', () => {
    const model = build(rows);
    const snap = model.crosshairSnap(iso('2026-05-08'));
    const wp = model.weightPoints.find((p) => p.date === '2026-05-08')!;
    expect(snap.left).not.toBeNull();
    expect(snap.left!.value).toBeCloseTo(178, 5);
    // The left arm lands exactly on the weight data point.
    expect(snap.left!.y).toBeCloseTo(wp.y, 5);
    // One right arm (single drug), positive mg-in-system (residual from 05-01).
    expect(snap.right).toHaveLength(1);
    expect(snap.right[0].value).toBeGreaterThan(0);
  });

  it('returns one right arm per drug when more than one is in system', () => {
    const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';
    const model = build([
      row({ date: iso('2026-05-01'), weight: '180', dose: '5', medication: SEMA }),
      row({ date: iso('2026-05-01'), dose: '10', medication: TIRZ }),
      row({ date: iso('2026-05-08'), weight: '178', dose: '5', medication: SEMA }),
      row({ date: iso('2026-05-08'), dose: '10', medication: TIRZ }),
    ]);
    const snap = model.crosshairSnap(iso('2026-05-08'));
    expect(snap.right).toHaveLength(2);
    // Each arm carries its own value and colour (not a combined total).
    const colors = new Set(snap.right.map((r) => r.color));
    expect(colors.size).toBe(2);
  });

  it('omits a drug that has zero in system on the hovered day', () => {
    const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';
    const model = build([
      row({ date: iso('2026-05-01'), weight: '180', dose: '5', medication: SEMA }),
      row({ date: iso('2026-05-08'), weight: '178', dose: '5', medication: SEMA }),
      // Tirzepatide's first dose is later, so on 05-08 it isn't in system yet.
      row({ date: iso('2026-05-09'), dose: '10', medication: TIRZ }),
    ]);
    const snap = model.crosshairSnap(iso('2026-05-08'));
    // Only Semaglutide — no zero-valued Tirzepatide arm.
    expect(snap.right).toHaveLength(1);
    expect(snap.right.every((r) => r.value > 0)).toBe(true);
  });

  it('returns a null left arm on a day with no weight (dose only)', () => {
    const model = build([
      row({ date: iso('2026-05-01'), weight: '180', dose: '5', medication: SEMA }),
      row({ date: iso('2026-05-08'), dose: '5', medication: SEMA }),
    ]);
    const snap = model.crosshairSnap(iso('2026-05-08'));
    expect(snap.left).toBeNull();
    expect(snap.right.length).toBeGreaterThan(0);
  });

  it('returns a null left arm when the weight series is hidden', () => {
    const model = buildChartModel(rows, 'lbs', {}, 180, TODAY, new SvelteSet<GraphSeriesKey>(['weight']));
    expect(model.crosshairSnap(iso('2026-05-08')).left).toBeNull();
  });
});

describe('buildChartModel — skipped-only date does not extend the chart', () => {
  it('a date whose only row is a skipped dose is not part of the chart range', () => {
    const rows = [
      row({ date: iso('2026-05-01'), weight: '180' }),
      row({ date: iso('2026-05-08'), weight: '178' }),
      row({ date: iso('2026-05-20'), dose: '5', medication: SEMA, doseSkipped: true }),
    ];
    const model = build(rows, iso('2026-05-08'));

    for (const series of model.systemSeries) {
      for (const point of [...series.dosePoints, ...series.plannedDosePoints]) {
        expect(point.date <= '2026-05-08').toBe(true);
      }
    }
    for (const point of model.weightPoints) {
      expect(point.date <= '2026-05-08').toBe(true);
    }
  });
});

describe('buildChartModel — empty input', () => {
  it('returns hasAnyData: false, no markers, no weight points', () => {
    const model = build([]);
    expect(model.hasAnyData).toBe(false);
    expect(model.weightPoints).toEqual([]);
    for (const series of model.systemSeries) {
      expect(series.dosePoints).toEqual([]);
      expect(series.plannedDosePoints).toEqual([]);
    }
  });

  it('rows with invalid date keys are ignored', () => {
    // The IsoDate brand prevents bad strings at compile time. To exercise the
    // runtime guard in `buildChartModel` we have to cast unsafely; this models
    // data that slipped past validation elsewhere (e.g. a corrupted import).
    const rows: ChartHealthRow[] = [
      row({ date: 'not-a-date' as IsoDate, dose: '5', medication: SEMA }),
      row({ date: 'also-bad' as IsoDate }),
    ];
    const model = build(rows);
    expect(model.hasAnyData).toBe(false);
  });
});

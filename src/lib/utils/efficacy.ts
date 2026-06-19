import { weekNumberFor } from '$lib/utils/weekNumber';
import type { IsoDate } from '$lib/domain/types';

/** One row of the Efficacy table — a single treatment week. */
export interface EfficacyRow {
  week: number;
  /** "<n> mg" for the week's last active dose, or '' when none (renders as —). */
  doseDisplay: string;
  /** Week-over-week loss in lbs vs the previous weighed week, or null (—). */
  lossLbs: number | null;
}

/** Minimal row shape the efficacy build needs. */
export interface EfficacyInputRow {
  date: IsoDate;
  weight: string;
  dose: string;
  doseSkipped?: boolean;
}

/**
 * Build the per-week efficacy rows.
 *
 * Weeks are numbered exactly like the inputs-table rail: anchored on the
 * earliest logged day (rolling 7-day blocks, anchor day = week 1) via the
 * shared {@link weekNumberFor}. Every week from 1 up to the last week that has
 * a weigh-in or an active dose is emitted — gap weeks in the middle are kept
 * and simply show dashes (empty dose, null loss), rather than truncating the
 * table at the first gap.
 *
 * `sortedRows` must be ascending by date (so "last weight/dose of the week"
 * resolves correctly and row 0 is the earliest logged day). Rows are returned
 * newest-week-first, matching the table's display order.
 */
export function buildEfficacyRows(sortedRows: readonly EfficacyInputRow[]): EfficacyRow[] {
  const weightRows = sortedRows.filter(
    (r) => r.weight !== '' && Number.isFinite(parseFloat(r.weight)),
  );
  if (weightRows.length < 2) return [];

  // Earliest logged day of any kind — rows are date-ascending, so it's row 0.
  const anchor = sortedRows[0].date;

  // Ascending iteration means the last value written for a week wins (i.e. the
  // latest weigh-in / dose that week), which is what each row reports.
  const lastWeightByWeek = new Map<number, number>();
  for (const r of weightRows) {
    const week = weekNumberFor(r.date, anchor);
    if (week !== null) lastWeightByWeek.set(week, parseFloat(r.weight));
  }
  const lastDoseByWeek = new Map<number, string>();
  for (const r of sortedRows) {
    if (r.dose === '' || r.doseSkipped) continue;
    const week = weekNumberFor(r.date, anchor);
    if (week !== null) lastDoseByWeek.set(week, r.dose);
  }

  // End at the last week that actually has weight or dose data; trailing weeks
  // with only other entries (symptoms/notes) don't warrant an efficacy row.
  const maxWeek = Math.max(0, ...lastWeightByWeek.keys(), ...lastDoseByWeek.keys());

  const rows: EfficacyRow[] = [];
  let prevWeightLbs: number | null = null;
  for (let week = 1; week <= maxWeek; week++) {
    const lastWeightLbs = lastWeightByWeek.get(week) ?? null;
    const doseStr = lastDoseByWeek.get(week);
    const doseDisplay = doseStr ? `${parseFloat(doseStr)} mg` : '';

    const lossLbs =
      lastWeightLbs !== null && prevWeightLbs !== null ? prevWeightLbs - lastWeightLbs : null;
    if (lastWeightLbs !== null) prevWeightLbs = lastWeightLbs;

    rows.push({ week, doseDisplay, lossLbs });
  }

  return rows.reverse();
}

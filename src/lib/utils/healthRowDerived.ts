import { parseDateKey } from '$lib/utils/dateKeys';
import type { IsoDate } from '$lib/domain/types';
import type { HealthInputRow, HealthSystemAmount } from '$lib/stores/healthTypes';
import {
  calculateSystemMgByDrug,
  drugDisplayColor,
  drugInitial,
  formatSystemMg,
  KG_PER_LB,
  type SystemDrugAmount,
  type WeighIn,
} from '$lib/utils/pharmacokinetics';

/**
 * How much of a row's derived fields need recomputing.
 *
 *  `full`   — Recompute every derived field. Safe default.
 *  `local`  — The change only touched fields that aren't inputs to any
 *             derived computation (notes, symptoms, wellness, shotLocation).
 *             No row's derived fields need updating.
 *  `weight` — A weight cell changed. Recomputed in full: a weight change
 *             shifts the loss chain and, via body-weight personalization, the
 *             PK math too (so it is treated the same as `full`).
 *  `pk`     — Dose / medication / doseSkipped changed. PK shifts but the loss
 *             chain is unaffected; existing loss/day are reused.
 *
 * Pre-boundary rows are always skipped (apart from possibly re-formatting
 * `system` when `showMedicationLetters` flips), regardless of scope.
 */
export type RecalcScope = 'full' | 'local' | 'weight' | 'pk';

export type RecalculateOptions = {
  defaultMedication: string;
  preserveOrder?: boolean;
  earliestChangedDate?: string;
  scope?: RecalcScope;
};

export function parseWeight(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function calculateDay(dateValue: string): string {
  if (!dateValue.trim()) return '';
  const parsedDate = parseDateKey(dateValue) ?? new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) return '';
  return parsedDate.toLocaleDateString('en-US', { weekday: 'long' });
}

export function calculateLoss(currentWeight: string, previousWeight: string): string {
  const current = parseWeight(currentWeight);
  const previous = parseWeight(previousWeight);
  if (current === null || previous === null) return '';
  return (previous - current).toFixed(1);
}

export function cloneRow<T extends HealthInputRow>(row: T): T {
  return { ...row, symptoms: [...row.symptoms], systemAmounts: [...(row.systemAmounts ?? [])] };
}

/**
 * The per-date **average** body weight (lbs) across all weigh-ins on each date.
 * Since rows are no longer merged by date, a day can have multiple weigh-ins;
 * the weight line, `loss`, the PK weigh-in personalisation, and latest/earliest
 * weight all use this single representative-per-date value. Dates with no
 * weigh-in are omitted.
 */
export function averageWeightLbsByDate(
  rows: Array<{ date: IsoDate; weightLbs?: number | null }>,
): Map<IsoDate, number> {
  const sums = new Map<IsoDate, { sum: number; n: number }>();
  for (const row of rows) {
    if (row.weightLbs == null || !Number.isFinite(row.weightLbs)) continue;
    const cur = sums.get(row.date) ?? { sum: 0, n: 0 };
    cur.sum += row.weightLbs;
    cur.n += 1;
    sums.set(row.date, cur);
  }
  const avg = new Map<IsoDate, number>();
  for (const [date, { sum, n }] of sums) avg.set(date, sum / n);
  return avg;
}

export function enrichSystemAmounts(amounts: SystemDrugAmount[]): HealthSystemAmount[] {
  return amounts.map((amount) => ({
    ...amount,
    color: drugDisplayColor(amount.medication),
    initial: drugInitial(amount.medication),
  }));
}

export function formatSystemAmounts(
  amounts: HealthSystemAmount[],
  showMedicationLetters: boolean,
): string {
  return amounts
    .map((amount) => {
      const value = formatSystemMg(amount.amountMg);
      return showMedicationLetters ? `${value} ${amount.initial}` : value;
    })
    .join('\n');
}

function reorderProcessed(
  processed: HealthInputRow[],
  sortedIndices: number[],
  preserveOrder: boolean,
  total: number,
): HealthInputRow[] {
  if (preserveOrder) {
    const result = new Array<HealthInputRow>(total);
    sortedIndices.forEach((originalIndex, sortedPos) => {
      result[originalIndex] = processed[sortedPos];
    });
    return result;
  }
  return processed.reverse();
}

export function recalculateDerived(
  rowsToUpdate: HealthInputRow[],
  options: RecalculateOptions,
): HealthInputRow[] {
  const { defaultMedication, preserveOrder = false, earliestChangedDate, scope = 'full' } = options;

  if (scope === 'local') {
    // Nothing derived needs updating anywhere; just clone for immutability.
    return rowsToUpdate.map(cloneRow);
  }

  // Sort chronologically so loss and PK calculations are always sequential.
  // Track original positions so we can restore order when preserveOrder is set.
  const sortedIndices = rowsToUpdate
    .map((_, i) => i)
    .sort((a, b) => rowsToUpdate[a].date.localeCompare(rowsToUpdate[b].date));
  const ascending = sortedIndices.map((i) => rowsToUpdate[i]);

  // When the caller knows the earliest date that could have changed, rows
  // strictly before that date can keep their existing derived values. We still
  // re-format their `system` string in case `showMedicationLetters` flipped
  // (e.g. a new medication appeared).
  const boundaryIdx = earliestChangedDate === undefined
    ? 0
    : ascending.findIndex((row) => row.date >= earliestChangedDate);
  const recomputeFromIdx = boundaryIdx === -1 ? ascending.length : boundaryIdx;

  // `pk`, `weight` and `full` all need the injection snapshot for PK math.
  // Older locally saved doses may not have a medication yet. Carry the last
  // known drug forward, then fall back to the current vial for new entries.
  let lastKnownMedication = '';
  const injectionSnapshot = ascending
    .map((row) => ({ row, amountMg: parseFloat(row.dose) }))
    .filter(({ row, amountMg }) => Number.isFinite(amountMg) && amountMg > 0 && !row.doseSkipped)
    .map((r) => {
      const medication = r.row.medication || lastKnownMedication || defaultMedication;
      if (medication) lastKnownMedication = medication;
      return { date: r.row.date, amountMg: r.amountMg, medication };
    })
    .filter((r) => r.medication);
  const showMedicationLetters = new Set(injectionSnapshot.map((inj) => inj.medication)).size > 1;
  const systemAmountsByDate = new Map<IsoDate, HealthSystemAmount[]>();

  // Weigh-ins (kg) individualize the PK model; row weights are stored in pounds.
  // A date can have multiple weigh-ins now, so use the per-date average (one
  // weigh-in per date) — same value that drives the weight line and `loss`.
  const avgWeightByDate = averageWeightLbsByDate(
    ascending.map((row) => ({ date: row.date, weightLbs: parseWeight(row.weight) })),
  );
  const weighIns: WeighIn[] = [...avgWeightByDate].map(([date, lbs]) => ({
    date,
    weightKg: lbs * KG_PER_LB,
  }));

  // `loss` is day-over-day on the per-date average: prev averaged-date minus this
  // averaged-date, shown on each weighed row of the date.
  const lossByDate = new Map<IsoDate, string>();
  {
    let prevAvg: number | null = null;
    for (const date of [...avgWeightByDate.keys()].sort()) {
      const avg = avgWeightByDate.get(date)!;
      lossByDate.set(date, prevAvg === null ? '' : (prevAvg - avg).toFixed(1));
      prevAvg = avg;
    }
  }

  const getSystemAmountsForDate = (date: IsoDate): HealthSystemAmount[] => {
    const cached = systemAmountsByDate.get(date);
    if (cached) return cached;
    const systemAmounts = enrichSystemAmounts(calculateSystemMgByDrug(injectionSnapshot, date, weighIns));
    systemAmountsByDate.set(date, systemAmounts);
    return systemAmounts;
  };

  // `pk` scope: keep existing day/loss, recompute only PK.
  if (scope === 'pk') {
    const processed = ascending.map((row, i) => {
      const nextRow = cloneRow(row);
      if (i < recomputeFromIdx) {
        if (!nextRow.doseSkipped && nextRow.systemAmounts.length > 0) {
          nextRow.system = formatSystemAmounts(nextRow.systemAmounts, showMedicationLetters);
        }
        return nextRow;
      }
      if (nextRow.doseSkipped) {
        nextRow.systemAmounts = [];
        nextRow.system = '';
      } else {
        const sys = getSystemAmountsForDate(nextRow.date);
        nextRow.systemAmounts = sys;
        nextRow.system = formatSystemAmounts(sys, showMedicationLetters);
      }
      return nextRow;
    });
    return reorderProcessed(processed, sortedIndices, preserveOrder, rowsToUpdate.length);
  }

  // `full` scope.
  const processed = ascending.map((row, i) => {
    if (i < recomputeFromIdx) {
      const nextRow = cloneRow(row);
      if (!nextRow.doseSkipped && nextRow.systemAmounts.length > 0) {
        nextRow.system = formatSystemAmounts(nextRow.systemAmounts, showMedicationLetters);
      }
      return nextRow;
    }
    const nextRow = cloneRow(row);
    nextRow.day = calculateDay(nextRow.date);
    nextRow.loss = parseWeight(nextRow.weight) !== null ? (lossByDate.get(nextRow.date) ?? '') : '';

    if (nextRow.doseSkipped) {
      nextRow.systemAmounts = [];
      nextRow.system = '';
    } else {
      const systemAmounts = getSystemAmountsForDate(nextRow.date);
      nextRow.systemAmounts = systemAmounts;
      nextRow.system = formatSystemAmounts(systemAmounts, showMedicationLetters);
    }

    return nextRow;
  });

  return reorderProcessed(processed, sortedIndices, preserveOrder, rowsToUpdate.length);
}

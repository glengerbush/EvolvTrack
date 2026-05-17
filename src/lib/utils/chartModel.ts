import type { IsoDate } from '$lib/domain/types';
import type { WeightUnit } from '$lib/stores/unitStore';
import {
  addDays,
  daysBetween,
  enumerateDateKeys,
  formatShortDate,
  isDateKey,
  maxDateKey,
  minDateKey,
} from '$lib/utils/dateKeys';
import { lbsToDisplayNum } from '$lib/utils/format';
import {
  calculateSystemMgByDrug,
  drugDisplayColor,
  drugDisplayShape,
  type DrugShape,
} from '$lib/utils/pharmacokinetics';
import { symptomColor, symptomInitial } from '$lib/utils/symptoms';
import { WELLNESS_SCORE_MAX, clampWellnessScore, parseWellnessScore } from '$lib/domain/wellness';

export type SystemGraphSeriesKey = 'systemMg' | `systemMg:${string}`;
export type GraphSeriesKey =
  | 'weight'
  | 'weightPrediction'
  | SystemGraphSeriesKey
  | 'wellness'
  | 'symptoms';

export type ChartHealthRow = {
  date: IsoDate;
  dose: string;
  dosePlanned: boolean;
  doseSkipped: boolean;
  medication: string;
  weight: string;
  wellness: string;
  symptoms: string[];
};

type DosePoint = {
  date: IsoDate;
  amountMg: number;
  medication: string;
  planned: boolean;
};

type NumberPoint = {
  date: IsoDate;
  x: number;
  y: number;
  value: number;
  planned?: boolean;
};

type WellnessBlock = {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type SystemDailySeries = {
  key: SystemGraphSeriesKey;
  label: string;
  medication?: string;
  color: string;
  shape: DrugShape;
  values: { date: IsoDate; value: number }[];
};

export type ChartSystemSeries = {
  key: SystemGraphSeriesKey;
  label: string;
  medication?: string;
  color: string;
  shape: DrugShape;
  actualPath: string;
  predictionPath: string;
  dosePoints: { date: IsoDate; x: number; y: number }[];
  plannedDosePoints: { date: IsoDate; x: number; y: number }[];
};

export type ChartModel = {
  hasAnyData: boolean;
  widthPx: number;
  plotRight: number;
  plotWidth: number;
  leftTicks: { value: number; label: string; y: number }[];
  rightTicks: { value: number; label: string; y: number }[];
  dateTicks: { date: IsoDate; label: string; x: number }[];
  wellnessStacks: { date: IsoDate; value: number; planned: boolean; blocks: WellnessBlock[] }[];
  symptomStacks: {
    date: IsoDate;
    x: number;
    items: { symptom: string; letter: string; color: string; y: number }[];
  }[];
  weightActualPath: string;
  weightFuturePath: string;
  weightPredictionPath: string;
  systemSeries: ChartSystemSeries[];
  weightPoints: NumberPoint[];
  todayX: number | null;
  leftAxisLabel: string;
  rightAxisLabel: string;
};

export const CHART = {
  width: 920,
  height: 440,
  margin: { top: 30, right: 68, bottom: 50, left: 58 },
};

export const PLOT = {
  left: CHART.margin.left,
  top: CHART.margin.top,
  right: CHART.width - CHART.margin.right,
  bottom: CHART.height - CHART.margin.bottom,
  width: CHART.width - CHART.margin.left - CHART.margin.right,
  height: CHART.height - CHART.margin.top - CHART.margin.bottom,
};

export const GRAPH_SERIES: { key: GraphSeriesKey; label: string; className: string }[] = [
  { key: 'weight', label: 'Weight', className: 'swatch-line swatch-weight' },
  { key: 'weightPrediction', label: 'Weight prediction', className: 'swatch-line swatch-weight-prediction' },
  { key: 'systemMg', label: 'mg in system', className: 'swatch-line swatch-system' },
  { key: 'wellness', label: 'Wellness score', className: 'swatch-bar swatch-wellness' },
  { key: 'symptoms', label: 'Symptoms', className: 'swatch-dot swatch-symptoms' },
];

const X_AXIS_PADDING = 18;
const DAY_PIXEL_WIDTH = 30;
const WELLNESS_BLOCK_GAP = 3;

type HiddenGraphSeries = {
  has(key: GraphSeriesKey): boolean;
};

export function buildChartModel(
  rows: ChartHealthRow[],
  unit: WeightUnit,
  colors: Record<string, string>,
  fallbackWeight: number,
  today: IsoDate,
  hiddenSeries: HiddenGraphSeries,
): ChartModel {
  // A skipped dose invalidates its entire row — weight, wellness, symptoms, and
  // the dose itself are all ignored for chart purposes.
  const datedRows = rows.filter((row) => isDateKey(row.date) && !row.doseSkipped);
  const doses = normalizeDoses(datedRows, today);
  const weights = collectWeights(datedRows, unit, today);
  const wellnessByDate = collectWellness(datedRows, today);
  const symptomsByDate = collectSymptoms(datedRows);
  const projectedDoseDates = doses.filter((dose) => dose.planned).map((dose) => dose.date);
  const confirmedDoseDates = doses.filter((dose) => !dose.planned).map((dose) => dose.date);
  const dataDates = datedRows.map((row) => row.date);

  let startDate = minDateKey(dataDates) ?? addDays(today, -28);
  let endDate = maxDateKey(dataDates) ?? today;

  if (daysBetween(startDate, endDate) < 1) {
    startDate = addDays(startDate, -7);
    endDate = addDays(endDate, 7);
  }

  const dateKeys = enumerateDateKeys(startDate, endDate);
  const widthPx = Math.max(CHART.width, CHART.margin.left + CHART.margin.right + (dateKeys.length - 1) * DAY_PIXEL_WIDTH);
  const plotRight = widthPx - CHART.margin.right;
  const plotWidth = widthPx - CHART.margin.left - CHART.margin.right;
  const daySpan = Math.max(daysBetween(startDate, endDate), 1);
  const usablePlotWidth = Math.max(plotWidth - X_AXIS_PADDING * 2, 1);
  const xForDate = (date: IsoDate) => {
    return PLOT.left + X_AXIS_PADDING + (daysBetween(startDate, date) / daySpan) * usablePlotWidth;
  };

  const systemDailySeries = buildSystemDailySeries(doses, dateKeys);

  const weightPrediction = buildWeightPrediction(weights, dateKeys);
  const weightValues = [...weights.map((point) => point.value), ...weightPrediction.map((point) => point.value)];
  const [rawLeftMin, leftMax] = paddedDomain(
    weightValues.length ? weightValues : [fallbackWeight],
    unit === 'kg' ? 0.5 : 1,
  );
  const leftMin = Math.max(rawLeftMin, 0);
  const visibleSystemSeries = systemDailySeries.filter((series) => !hiddenSeries.has(series.key));
  const showSysMg = visibleSystemSeries.length > 0;
  const showWellness = !hiddenSeries.has('wellness');
  const rightAxisValues: number[] = [];
  if (showSysMg) {
    rightAxisValues.push(
      ...visibleSystemSeries.flatMap((series) => series.values.map((point) => point.value)),
    );
  }
  const rightMax = rightAxisMax(rightAxisValues, showWellness && !showSysMg ? WELLNESS_SCORE_MAX : 5);
  const rightAxisLabel =
    showSysMg ? 'mg in system' :
    showWellness ? 'Wellness score' :
    'mg in system / wellness';
  const yLeft = (value: number) => PLOT.bottom - ((value - leftMin) / (leftMax - leftMin)) * PLOT.height;
  const yRight = (value: number) => PLOT.bottom - (value / rightMax) * PLOT.height;
  const projectionStartDate = getProjectionStartDate(today, projectedDoseDates, confirmedDoseDates, endDate);

  const takenDoses = doses.filter((dose) => !dose.planned);
  const plannedDoses = doses.filter((dose) => dose.planned);
  const systemSeries = systemDailySeries.map((series) => {
    const points = series.values.map((point) => ({
      ...point,
      x: xForDate(point.date),
      y: yRight(point.value),
    }));
    const split = splitProjectedPoints(points, projectionStartDate);

    const isUnified = series.key === 'systemMg';
    const filterForSeries = (dose: DosePoint) =>
      isUnified || dose.medication === series.medication;
    const pointsByDate = new Map(points.map((p) => [p.date, p]));
    const toMarkers = (source: DosePoint[]) =>
      source.filter(filterForSeries).flatMap((dose) => {
        const point = pointsByDate.get(dose.date);
        return point ? [{ date: dose.date, x: point.x, y: point.y }] : [];
      });

    return {
      key: series.key,
      label: series.label,
      medication: series.medication,
      color: series.color,
      shape: series.shape,
      actualPath: toPolyline(split.actual),
      predictionPath: toPolyline(split.projected),
      dosePoints: toMarkers(takenDoses),
      plannedDosePoints: toMarkers(plannedDoses),
    };
  });
  const weightPoints = weights.map((point) => ({
    ...point,
    x: xForDate(point.date),
    y: yLeft(point.value),
  }));
  const weightSplit = splitWeightPointsByPlanned(weightPoints);
  const weightPredictionPoints = weightPrediction.map((point) => ({
    ...point,
    x: xForDate(point.date),
    y: yLeft(point.value),
  }));
  const daySpacing = usablePlotWidth / daySpan;
  const barWidth = Math.max(5, Math.min(20, daySpacing * 0.72));

  return {
    hasAnyData: datedRows.length > 0,
    widthPx,
    plotRight,
    plotWidth,
    leftTicks: buildTicks(leftMin, leftMax, 5).map((value) => ({
      value,
      label: formatAxisNumber(value),
      y: yLeft(value),
    })),
    rightTicks: buildTicks(0, rightMax, 5).map((value) => ({
      value,
      label: formatAxisNumber(value),
      y: yRight(value),
    })),
    dateTicks: buildDateTicks(dateKeys, xForDate),
    wellnessStacks: dateKeys.map((date) => {
      const entry = wellnessByDate.get(date);
      const value = entry?.value ?? 0;
      return {
        date,
        value,
        planned: entry?.planned ?? false,
        blocks: buildWellnessBlocks(value, xForDate(date) - barWidth / 2, barWidth),
      };
    }),
    symptomStacks: dateKeys
      .map((date) => ({
        date,
        x: xForDate(date),
        items: (symptomsByDate.get(date) ?? []).map((item, index) => ({
          symptom: item,
          letter: symptomInitial(item),
          color: symptomColor(item, colors),
          y: PLOT.bottom - 11 - index * 18,
        })),
      }))
      .filter((stack) => stack.items.length > 0),
    weightActualPath: toPolyline(weightSplit.actual),
    weightFuturePath: toPolyline(weightSplit.projected),
    weightPredictionPath: toPolyline(weightPredictionPoints),
    systemSeries,
    weightPoints,
    todayX: today >= startDate && today <= endDate ? xForDate(today) : null,
    leftAxisLabel: `Weight (${unit})`,
    rightAxisLabel,
  };
}

function buildSystemDailySeries(doses: DosePoint[], dateKeys: IsoDate[]): SystemDailySeries[] {
  const actualMedications = uniqueMedications(doses.filter((dose) => !dose.planned));
  const splitByDrug = actualMedications.length > 1;
  const amountsByDate = new Map<string, Map<string, number>>();

  const amountsForDate = (date: IsoDate) => {
    const cached = amountsByDate.get(date);
    if (cached) return cached;

    const amounts = new Map<string, number>();
    for (const amount of calculateSystemMgByDrug(doses, date)) {
      amounts.set(amount.medication, amount.amountMg);
    }
    amountsByDate.set(date, amounts);
    return amounts;
  };

  if (!splitByDrug) {
    const medication = actualMedications[0] ?? uniqueMedications(doses)[0];

    return [{
      key: 'systemMg',
      label: 'mg in system',
      medication,
      color: medication ? drugDisplayColor(medication) : 'var(--drug-sema)',
      shape: medication ? drugDisplayShape(medication) : 'circle',
      values: dateKeys.map((date) => ({
        date,
        value: [...amountsForDate(date).values()].reduce((sum, value) => sum + value, 0),
      })),
    }];
  }

  return actualMedications.map((medication) => ({
    key: systemDrugKey(medication),
    label: `${drugShortName(medication)} in System`,
    medication,
    color: drugDisplayColor(medication),
    shape: drugDisplayShape(medication),
    values: dateKeys.map((date) => ({
      date,
      value: amountsForDate(date).get(medication) ?? 0,
    })),
  }));
}

function uniqueMedications(doses: DosePoint[]): string[] {
  const seen = new Set<string>();
  const medications: string[] = [];

  for (const dose of doses) {
    if (!dose.medication || seen.has(dose.medication)) continue;
    seen.add(dose.medication);
    medications.push(dose.medication);
  }

  return medications;
}

function systemDrugKey(medication: string): SystemGraphSeriesKey {
  return `systemMg:${medication}`;
}

function drugShortName(medication: string): string {
  return medication.split('(')[0]?.trim() || medication;
}

function normalizeDoses(rows: ChartHealthRow[], today: IsoDate): DosePoint[] {
  let lastKnownMedication = '';
  return rows
    .filter((row) => isDateKey(row.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((row) => {
      const medication = row.medication || lastKnownMedication;
      if (row.medication) lastKnownMedication = row.medication;

      const amountMg = parseFloat(row.dose);
      if (!Number.isFinite(amountMg) || amountMg <= 0 || !medication) return [];

      return [{
        date: row.date,
        amountMg,
        medication,
        planned: row.dosePlanned || row.date > today,
      }];
    });
}

function collectWeights(rows: ChartHealthRow[], unit: WeightUnit, today: IsoDate) {
  // A weight is "planned" if it shares a row with an unconfirmed (planned) dose,
  // or simply lives on a future date.
  const byDate = new Map<IsoDate, { value: number; planned: boolean }>();
  for (const row of rows) {
    const value = lbsToDisplayNum(row.weight, unit);
    if (!Number.isFinite(value)) continue;
    const planned = row.dosePlanned || row.date > today;
    const existing = byDate.get(row.date);
    if (existing && !existing.planned && planned) continue;
    byDate.set(row.date, { value, planned });
  }

  return [...byDate]
    .map(([date, { value, planned }]) => ({ date, value, planned }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function collectWellness(rows: ChartHealthRow[], today: IsoDate) {
  // Track planned and actual wellness samples separately per date. If a date has
  // any actual samples, prefer those; otherwise fall back to the planned average.
  type DateTotal = { actualSum: number; actualCount: number; plannedSum: number; plannedCount: number };
  const totalsByDate = new Map<IsoDate, DateTotal>();
  for (const row of rows) {
    const wellness = parseWellnessScore(row.wellness);
    if (wellness === undefined) continue;

    const planned = row.dosePlanned || row.date > today;
    const total = totalsByDate.get(row.date) ?? { actualSum: 0, actualCount: 0, plannedSum: 0, plannedCount: 0 };
    if (planned) { total.plannedSum += wellness; total.plannedCount += 1; }
    else { total.actualSum += wellness; total.actualCount += 1; }
    totalsByDate.set(row.date, total);
  }

  const byDate = new Map<IsoDate, { value: number; planned: boolean }>();
  for (const [date, total] of totalsByDate) {
    if (total.actualCount > 0) byDate.set(date, { value: total.actualSum / total.actualCount, planned: false });
    else if (total.plannedCount > 0) byDate.set(date, { value: total.plannedSum / total.plannedCount, planned: true });
  }
  return byDate;
}

function buildWellnessBlocks(value: number, x: number, width: number): WellnessBlock[] {
  const clamped = clampWellnessScore(value);
  const fullBlocks = Math.floor(clamped);
  const partialBlock = clamped - fullBlocks;
  const blockCount = fullBlocks + (partialBlock > 0 ? 1 : 0);
  const slotHeight = PLOT.height / WELLNESS_SCORE_MAX;
  const blockGap = Math.min(WELLNESS_BLOCK_GAP, slotHeight * 0.25);
  const blockHeight = Math.max(slotHeight - blockGap, 1);

  return Array.from({ length: blockCount }, (_, index) => {
    const fillRatio = index < fullBlocks ? 1 : partialBlock;
    const height = blockHeight * fillRatio;
    const slotTop = PLOT.bottom - (index + 1) * slotHeight + blockGap / 2;

    return {
      index,
      x,
      y: slotTop + blockHeight - height,
      width,
      height,
    };
  });
}

function collectSymptoms(rows: ChartHealthRow[]) {
  const byDate = new Map<IsoDate, string[]>();
  for (const row of rows) {
    const existing = byDate.get(row.date) ?? [];
    for (const symptom of row.symptoms) {
      if (!existing.includes(symptom)) existing.push(symptom);
    }
    if (existing.length) byDate.set(row.date, existing);
  }
  return byDate;
}

function buildWeightPrediction(weights: { date: IsoDate; value: number }[], dateKeys: IsoDate[]) {
  const lastActual = weights.at(-1);
  if (!lastActual) return [];
  const lastVisibleDate = dateKeys.at(-1);
  if (!lastVisibleDate || lastActual.date >= lastVisibleDate) return [];

  const recent = weights.slice(-4);
  const first = recent[0];
  const last = recent.at(-1) ?? first;
  const daySpan = Math.max(daysBetween(first.date, last.date), 1);
  const dailySlope = recent.length > 1 ? (last.value - first.value) / daySpan : 0;

  return dateKeys
    .filter((date) => date >= lastActual.date)
    .map((date) => ({
      date,
      value: Math.max(lastActual.value + dailySlope * daysBetween(lastActual.date, date), 0),
    }));
}

function splitProjectedPoints(points: NumberPoint[], projectionStartDate: IsoDate | null) {
  if (!projectionStartDate) return { actual: points, projected: [] };

  const actual = points.filter((point) => point.date < projectionStartDate);
  const projected = points.filter((point) => point.date >= projectionStartDate);
  const anchor = actual.at(-1);
  return {
    actual,
    projected: anchor && projected.length ? [anchor, ...projected] : projected,
  };
}

function splitWeightPointsByPlanned(points: NumberPoint[]): { actual: NumberPoint[]; projected: NumberPoint[] } {
  const firstPlannedIndex = points.findIndex((p) => p.planned);
  if (firstPlannedIndex === -1) return { actual: points, projected: [] };
  const actual = points.slice(0, firstPlannedIndex);
  const planned = points.slice(firstPlannedIndex);
  const anchor = actual.at(-1);
  return {
    actual,
    projected: anchor ? [anchor, ...planned] : planned,
  };
}

function getProjectionStartDate(
  today: IsoDate,
  projectedDoseDates: IsoDate[],
  confirmedDoseDates: IsoDate[],
  endDate: IsoDate,
) {
  const latestConfirmed = maxDateKey(confirmedDoseDates);
  const relevantPlanned = projectedDoseDates.filter((p) => {
    if (p >= today) return true;
    return latestConfirmed === null || p > latestConfirmed;
  });
  if (!relevantPlanned.length && endDate <= today) return null;
  const tomorrow = addDays(today, 1);
  const firstProjectedDose = minDateKey(relevantPlanned);
  // A dose contributes 0 to its own day's system value (per pharmacokinetics
  // same-day-zero rule), so the dashed segment starts the day after the
  // first planned dose, not on it.
  const dashedFromPlanned = firstProjectedDose ? addDays(firstProjectedDose, 1) : null;
  return minDateKey([tomorrow, dashedFromPlanned].filter((d): d is IsoDate => d !== null));
}

function buildDateTicks(
  dateKeys: IsoDate[],
  xForDate: (date: IsoDate) => number,
) {
  return dateKeys.map((date) => ({ date, label: formatShortDate(date), x: xForDate(date) }));
}

function paddedDomain(values: number[], minPadding: number): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (min === max) {
    min -= minPadding;
    max += minPadding;
  }

  const pad = Math.max((max - min) * 0.12, minPadding);
  return [Math.floor((min - pad) * 10) / 10, Math.ceil((max + pad) * 10) / 10];
}

function rightAxisMax(values: number[], baselineMax = 5) {
  const max = Math.max(...values.filter(Number.isFinite), baselineMax);
  if (max <= baselineMax) return baselineMax;

  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = magnitude / 2;
  return Math.ceil((max * 1.12) / step) * step;
}

function buildTicks(min: number, max: number, count: number) {
  const step = (max - min) / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
}

function toPolyline(points: NumberPoint[]) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

function formatAxisNumber(value: number) {
  return Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
}

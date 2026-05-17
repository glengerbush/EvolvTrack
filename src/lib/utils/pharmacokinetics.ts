// PK parameters sourced from:
//   Semaglutide  — PMC11215664, PMID 29915923, PMC6437231 (ka)
//   Tirzepatide  — PMC10962491, NBK585056 (ka from Table 3)
//   Dulaglutide  — PMID 26507721, PMC12052016
//   Liraglutide  — PMC4875959,  NBK608007
//   Retatrutide  — NEJM NEJMoa2301972, PMC12190491

import type { IsoDate, Medication } from '$lib/domain/types';

export type DrugPK = {
  halfLifeHours: number;
  tmaxHours: number;
  bioavailability: number;
  ka: number; // absorption rate constant (1/h)
  ke: number; // elimination rate constant (1/h) = ln(2) / halfLifeHours
};

export type SystemDrugAmount = {
  medication: Medication;
  amountMg: number;
};

// ka sources: published population PK estimates are used for semaglutide and
// tirzepatide; for the others no compatible published ka exists so ka is solved
// numerically from label Tmax via Tmax = ln(ka/ke) / (ka - ke).
export const DRUG_PK: Record<Medication, DrugPK> = {
  'Semaglutide (Ozempic / Wegovy)': {
    halfLifeHours: 168,
    tmaxHours: 86,         // implied by published ka (Overgaard 2019, PMC6437231)
    bioavailability: 0.89,
    ka: 0.0253,            // h⁻¹, population PK estimate (Overgaard 2019, PMC6437231)
    ke: Math.LN2 / 168,
  },
  'Tirzepatide (Mounjaro / Zepbound)': {
    halfLifeHours: 120,
    tmaxHours: 59,         // implied by published ka (Schneck 2024, PMC10962491 Table 3)
    bioavailability: 0.80,
    ka: 0.0373,            // h⁻¹, population PK estimate (Schneck 2024, PMC10962491)
    ke: Math.LN2 / 120,
  },
  'Dulaglutide (Trulicity)': {
    halfLifeHours: 112.8,
    tmaxHours: 48,
    bioavailability: 0.47, // doses ≥ 1.5 mg (DailyMed); 0.75 mg is ~0.65
    ka: 0.050,             // h⁻¹, solved from Tmax = 48h; published model is 2-compartment
    ke: Math.LN2 / 112.8,
  },
  'Liraglutide (Victoza / Saxenda)': {
    halfLifeHours: 13,
    tmaxHours: 10,
    bioavailability: 0.55,
    ka: 0.170,             // h⁻¹, solved from Tmax ≈ 10h; published models use zero-order
                           // + lag-time absorption (incompatible with Bateman equation)
    ke: Math.LN2 / 13,
  },
  'Retatrutide': {
    halfLifeHours: 144,
    tmaxHours: 36,
    bioavailability: 0.80,
    ka: 0.085,             // h⁻¹, solved from Tmax = 36h; no published pop PK model yet
    ke: Math.LN2 / 144,
  },
};

// Drug colors are exposed as CSS custom property references so the dashboard
// can re-skin them per theme. The concrete values are defined in
// `dashboardTheme.ts` (`drugPalettes`) and emitted as CSS variables by
// `Dashboard.svelte` based on the active theme.
export const DRUG_DISPLAY_COLORS: Record<Medication, string> = {
  'Semaglutide (Ozempic / Wegovy)': 'var(--drug-sema)',
  'Tirzepatide (Mounjaro / Zepbound)': 'var(--drug-tirz)',
  'Dulaglutide (Trulicity)': 'var(--drug-dula)',
  'Liraglutide (Victoza / Saxenda)': 'var(--drug-lira)',
  Retatrutide: 'var(--drug-reta)',
};

export const DRUG_FALLBACK_PALETTE: string[] = [
  'var(--drug-palette-0)',
  'var(--drug-palette-1)',
  'var(--drug-palette-2)',
  'var(--drug-palette-3)',
  'var(--drug-palette-4)',
  'var(--drug-palette-5)',
  'var(--drug-palette-6)',
];

// Universal-design markers: every drug also gets a distinct *shape* so series
// stay distinguishable when colors are similar (greyscale theme, overlapping
// lines, color-vision differences, printouts).
export type DrugShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'plus' | 'star' | 'hexagon';

export const DRUG_DISPLAY_SHAPES: Record<Medication, DrugShape> = {
  'Semaglutide (Ozempic / Wegovy)': 'circle',
  'Tirzepatide (Mounjaro / Zepbound)': 'square',
  'Dulaglutide (Trulicity)': 'triangle',
  'Liraglutide (Victoza / Saxenda)': 'diamond',
  Retatrutide: 'plus',
};

export const DRUG_FALLBACK_SHAPES: DrugShape[] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'plus',
  'star',
  'hexagon',
];

export function drugDisplayShape(medication: string): DrugShape {
  const known = (DRUG_DISPLAY_SHAPES as Record<string, DrugShape>)[medication];
  if (known) return known;

  let hash = 0;
  for (const char of medication) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return DRUG_FALLBACK_SHAPES[hash % DRUG_FALLBACK_SHAPES.length];
}

/**
 * Bateman equation: mg of drug remaining in body at time t (hours) after a
 * single subcutaneous dose, using a one-compartment first-order absorption /
 * elimination model.
 */
function batemanAmountMg(doseMg: number, pk: DrugPK, tHours: number): number {
  if (tHours <= 0) return 0;
  const { bioavailability: F, ka, ke } = pk;
  return ((F * doseMg * ka) / (ka - ke)) * (Math.exp(-ke * tHours) - Math.exp(-ka * tHours));
}

// Parse YYYY-MM-DD as local midnight so timezone offsets don't shift the date.
function localMidnight(isoDate: IsoDate): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function roundMg(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function drugInitial(medication: string): string {
  return medication.trim().charAt(0).toUpperCase() || '?';
}

export function drugDisplayColor(medication: string): string {
  const knownColor = (DRUG_DISPLAY_COLORS as Record<string, string>)[medication];
  if (knownColor) return knownColor;

  let hash = 0;
  for (const char of medication) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return DRUG_FALLBACK_PALETTE[hash % DRUG_FALLBACK_PALETTE.length];
}

export function formatSystemMg(amount: number): string {
  return String(roundMg(amount));
}

/**
 * Drug-specific mg in body on a given date. Injection is assumed to occur at
 * the start (00:00) of its date; the system amount is evaluated at the start
 * (00:00) of targetDate.
 *
 * A same-day injection therefore contributes 0 to that day's value -- it
 * represents what was already circulating before the new dose.
 */
export function calculateSystemMgByDrug(
  injections: { date: IsoDate; amountMg: number; medication: string }[],
  targetDate: IsoDate,
): SystemDrugAmount[] {
  const targetMs = localMidnight(targetDate);
  const totals = new Map<Medication, number>();

  for (const inj of injections) {
    const pk = (DRUG_PK as Record<string, DrugPK>)[inj.medication];
    if (!pk) continue;

    const tHours = (targetMs - localMidnight(inj.date)) / (1000 * 60 * 60);
    if (tHours < 0) continue;

    const med = inj.medication as Medication;
    totals.set(med, (totals.get(med) ?? 0) + batemanAmountMg(inj.amountMg, pk, tHours));
  }

  return [...totals]
    .map(([medication, amountMg]) => ({ medication, amountMg: roundMg(amountMg) }))
    .filter(({ amountMg }) => amountMg > 0);
}

/**
 * Total mg of drug(s) in body on a given date, summed across all logged
 * injections. Injection is assumed to occur at the start (00:00) of its date;
 * the system amount is evaluated at the start (00:00) of targetDate.
 *
 * A same-day injection therefore contributes 0 to that day's value —
 * it represents what was already circulating before the new dose.
 */
export function calculateSystemMg(
  injections: { date: IsoDate; amountMg: number; medication: string }[],
  targetDate: IsoDate,
): number {
  const total = calculateSystemMgByDrug(injections, targetDate)
    .reduce((sum, amount) => sum + amount.amountMg, 0);
  return roundMg(total);
}

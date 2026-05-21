// PK parameters sourced from:
//   Semaglutide  — PMC11215664, PMID 29915923, PMC6437231 (ka)
//   Tirzepatide  — PMC10962491, NBK585056 (ka from Table 3)
//   Dulaglutide  — Geiser et al. 2015, PMID 26507721 (two-compartment popPK, Table 6)
//   Liraglutide  — PMC4875959,  NBK608007
//   Retatrutide  — NEJM NEJMoa2301972, PMC12190491

import type { IsoDate, Medication } from '$lib/domain/types';

// Most drugs use a one-compartment model: first-order absorption into a single
// body compartment, first-order elimination. The amount in body is the Bateman
// equation.
export type OneCompartmentPK = {
  model: 'one-compartment';
  halfLifeHours: number;
  tmaxHours: number;
  bioavailability: number;
  ka: number; // absorption rate constant (1/h)
  ke: number; // elimination rate constant (1/h) = ln(2) / halfLifeHours
};

// How body weight modifies a drug's PK, taken from the same population-PK
// papers as the base parameters. A drug with no covariate is modeled at the
// population-typical (reference-weight) values.
export type WeightCovariate =
  | {
      // Clearance and volume scale allometrically with body weight, so the
      // disposition rate constants k10/k12/k21 each scale by
      // (weightKg / referenceWeightKg) ^ exponent. The exponent is the
      // clearance allometric exponent minus the volume allometric exponent.
      kind: 'allometric-disposition';
      referenceWeightKg: number;
      exponent: number;
    }
  | {
      // Bioavailability scales with body weight:
      //   F = baseF · exp(coefficient · (weightKg − referenceWeightKg))
      kind: 'exponential-bioavailability';
      referenceWeightKg: number;
      coefficient: number;
    };

// Two-compartment model: first-order absorption into a central compartment
// that exchanges with a peripheral compartment; elimination from central only.
// The tracked "amount in system" is the central-compartment amount, which is
// proportional to plasma concentration.
export type TwoCompartmentPK = {
  model: 'two-compartment';
  bioavailability: number;
  ka: number; // absorption rate constant (1/h)
  k10: number; // elimination from central (1/h) = (CL/F) / (Vc/F)
  k12: number; // central → peripheral (1/h)    = (Q/F)  / (Vc/F)
  k21: number; // peripheral → central (1/h)    = (Q/F)  / (Vp/F)
  // Body-weight covariate; when set and a weigh-in is available the curve is
  // individualized to the user's weight (see decayTerms).
  weightCovariate?: WeightCovariate;
};

export type DrugPK = OneCompartmentPK | TwoCompartmentPK;

export type SystemDrugAmount = {
  medication: Medication;
  amountMg: number;
};

// Semaglutide, tirzepatide and dulaglutide use complete published
// two-compartment population PK models. Liraglutide and retatrutide use the
// one-compartment Bateman form; no compatible published ka exists for them, so
// ka is solved numerically from label Tmax via Tmax = ln(ka/ke) / (ka - ke).
export const DRUG_PK: Record<Medication, DrugPK> = {
  // Two-compartment population PK model (Overgaard et al. 2019, PMID 30788808,
  // Table 4). Published parameters: CL 0.0348 L/h, Vc 3.59 L, Vp 4.10 L,
  // Q 0.304 L/h — the micro-rate constants below are derived from those.
  // Central-compartment peak ~3 days after a dose. Body weight scales CL/Q by
  // ^1.01 and the volumes by ^0.923 (Table 4), so the disposition rates scale
  // by weight^(1.01−0.923); reference subject 85 kg.
  'Semaglutide (Ozempic / Wegovy)': {
    model: 'two-compartment',
    bioavailability: 0.847, // absolute bioavailability (Overgaard 2019, Table 4)
    ka: 0.0253,             // h⁻¹ (Overgaard 2019, Table 4)
    k10: 0.0348 / 3.59,     // CL / Vc
    k12: 0.304 / 3.59,      // Q  / Vc
    k21: 0.304 / 4.1,       // Q  / Vp
    weightCovariate: { kind: 'allometric-disposition', referenceWeightKg: 85, exponent: 1.01 - 0.923 },
  },
  // Two-compartment population PK model (Schneck et al. 2024, PMID 38356317,
  // Table 3). Published parameters per 70 kg: CL 0.0329 L/h, Vc 2.47 L,
  // Vp 3.98 L, Q 0.126 L/h — the micro-rate constants below are derived from
  // those. Central-compartment peak ~1.3 days after a dose. Body weight scales
  // CL/Q by ^0.8 and the volumes by ^1.0 (Table 3), so the disposition rates
  // scale by weight^(0.8−1.0); reference 70 kg. (The model's fat-mass term on
  // volume is omitted — it needs body-composition data the app does not have.)
  'Tirzepatide (Mounjaro / Zepbound)': {
    model: 'two-compartment',
    bioavailability: 0.8,   // fixed (Schneck 2024, Table 3)
    ka: 0.0373,             // h⁻¹ (Schneck 2024, Table 3)
    k10: 0.0329 / 2.47,     // CL / Vc  (per 70 kg)
    k12: 0.126 / 2.47,      // Q  / Vc  (per 70 kg)
    k21: 0.126 / 3.98,      // Q  / Vp  (per 70 kg)
    weightCovariate: { kind: 'allometric-disposition', referenceWeightKg: 70, exponent: 0.8 - 1 },
  },
  // Two-compartment population PK model (Geiser et al. 2015, PMID 26507721,
  // Table 6). Published macro-parameters: CL/F 0.0593 L/h, Vc/F 2.25 L,
  // Vp/F 3.75 L, Q/F 0.0201 L/h — the micro-rate constants below are derived
  // from those. The model predicts a broad central-compartment peak roughly
  // 2.5 days after the dose and a ~7.5-day terminal half-life. Body weight is a
  // covariate on bioavailability (Table 6); reference 92.5 kg.
  'Dulaglutide (Trulicity)': {
    model: 'two-compartment',
    bioavailability: 0.47, // 1.5 mg dose, absolute-BA study (Geiser 2015)
    ka: 0.00769,           // h⁻¹, published estimate (Geiser 2015, Table 6)
    k10: 0.0593 / 2.25,    // (CL/F) / (Vc/F)
    k12: 0.0201 / 2.25,    // (Q/F)  / (Vc/F)
    k21: 0.0201 / 3.75,    // (Q/F)  / (Vp/F)
    weightCovariate: { kind: 'exponential-bioavailability', referenceWeightKg: 92.5, coefficient: -0.00877 },
  },
  'Liraglutide (Victoza / Saxenda)': {
    model: 'one-compartment',
    halfLifeHours: 13,
    tmaxHours: 10,
    bioavailability: 0.55,
    ka: 0.170,             // h⁻¹, solved from Tmax ≈ 10h; published models use zero-order
                           // + lag-time absorption (incompatible with Bateman equation)
    ke: Math.LN2 / 13,
  },
  'Retatrutide': {
    model: 'one-compartment',
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
 * One exponential term of a drug's single-dose disposition curve. The amount
 * of drug in the tracked compartment t hours after a dose of `doseMg` is:
 *   doseMg · Σ coefficient · exp(-rateConstant · t)
 */
export type DecayTerm = { coefficient: number; rateConstant: number };

/**
 * Two-compartment hybrid disposition rates: the roots of the disposition
 * quadratic λ² − (k10 + k12 + k21)·λ + k10·k21 = 0. `alpha` is the fast
 * distribution phase, `beta` the slow terminal phase. Exported so the
 * spreadsheet export can rebuild the weight-scaled curve.
 */
export function dispositionRates(
  k10: number,
  k12: number,
  k21: number,
): { alpha: number; beta: number } {
  const sum = k10 + k12 + k21;
  const root = Math.sqrt(sum * sum - 4 * k10 * k21);
  return { alpha: (sum + root) / 2, beta: (sum - root) / 2 };
}

/**
 * Decompose a drug's single-dose curve into exponential terms. A
 * one-compartment model yields two terms (the Bateman equation); the
 * two-compartment central compartment yields three.
 *
 * When the drug carries a body-weight covariate and `weightKg` is supplied the
 * curve is individualized: an allometric covariate scales the disposition rate
 * constants, a bioavailability covariate scales F.
 */
function decayTerms(pk: DrugPK, weightKg?: number): DecayTerm[] {
  if (pk.model === 'two-compartment') {
    const { ka } = pk;
    let { k10, k12, k21 } = pk;
    let F = pk.bioavailability;
    const cov = pk.weightCovariate;
    if (cov && weightKg != null) {
      if (cov.kind === 'allometric-disposition') {
        const factor = (weightKg / cov.referenceWeightKg) ** cov.exponent;
        k10 *= factor;
        k12 *= factor;
        k21 *= factor;
      } else {
        F *= Math.exp(cov.coefficient * (weightKg - cov.referenceWeightKg));
      }
    }
    const { alpha, beta } = dispositionRates(k10, k12, k21);
    const scale = F * ka;
    return [
      { coefficient: (scale * (k21 - ka)) / ((alpha - ka) * (beta - ka)), rateConstant: ka },
      { coefficient: (scale * (k21 - alpha)) / ((ka - alpha) * (beta - alpha)), rateConstant: alpha },
      { coefficient: (scale * (k21 - beta)) / ((ka - beta) * (alpha - beta)), rateConstant: beta },
    ];
  }
  // One-compartment Bateman, written as a sum of exponentials:
  //   F·D·ka/(ka−ke)·(e^−ke·t − e^−ka·t)
  const scale = (pk.bioavailability * pk.ka) / (pk.ka - pk.ke);
  return [
    { coefficient: scale, rateConstant: pk.ke },
    { coefficient: -scale, rateConstant: pk.ka },
  ];
}

/**
 * mg of drug in the tracked compartment at time t (hours) after a single dose.
 * A same-day (t ≤ 0) dose contributes 0 — see calculateSystemMgByDrug.
 */
function amountFromTerms(terms: DecayTerm[], doseMg: number, tHours: number): number {
  if (tHours <= 0) return 0;
  let sum = 0;
  for (const term of terms) {
    sum += term.coefficient * Math.exp(-term.rateConstant * tHours);
  }
  return doseMg * sum;
}

/**
 * Exponential terms for a medication's single-dose curve, or null if the drug
 * has no PK model. Exposed so other modules (e.g. the spreadsheet export) can
 * reproduce the curve without re-deriving the parameters. Pass `weightKg` to
 * individualize a drug that has a body-weight covariate.
 */
export function systemDecayTerms(medication: string, weightKg?: number): DecayTerm[] | null {
  const pk = (DRUG_PK as Record<string, DrugPK>)[medication];
  return pk ? decayTerms(pk, weightKg) : null;
}

/** A body-weight measurement used to individualize the PK model. */
export type WeighIn = { date: IsoDate; weightKg: number };

/** Pounds → kilograms. Weights are stored in pounds; PK covariates use kg. */
export const KG_PER_LB = 0.45359237;

/**
 * The body weight (kg) to apply to a dose given on `date`: the most recent
 * weigh-in on or before that date, or undefined when there is none (callers
 * then fall back to the population reference weight). IsoDate strings sort
 * lexicographically, so plain string comparison gives date order.
 */
export function weightForDate(weighIns: WeighIn[], date: IsoDate): number | undefined {
  let best: WeighIn | undefined;
  for (const w of weighIns) {
    if (w.date <= date && (best === undefined || w.date > best.date)) best = w;
  }
  return best?.weightKg;
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
 *
 * `weighIns` individualizes drugs with a body-weight covariate: each dose uses
 * the most recent weigh-in on or before its own date.
 */
export function calculateSystemMgByDrug(
  injections: { date: IsoDate; amountMg: number; medication: string }[],
  targetDate: IsoDate,
  weighIns: WeighIn[] = [],
): SystemDrugAmount[] {
  const targetMs = localMidnight(targetDate);
  const totals = new Map<Medication, number>();

  for (const inj of injections) {
    const terms = systemDecayTerms(inj.medication, weightForDate(weighIns, inj.date));
    if (!terms) continue;

    const tHours = (targetMs - localMidnight(inj.date)) / (1000 * 60 * 60);
    if (tHours < 0) continue;

    const med = inj.medication as Medication;
    totals.set(med, (totals.get(med) ?? 0) + amountFromTerms(terms, inj.amountMg, tHours));
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
  weighIns: WeighIn[] = [],
): number {
  const total = calculateSystemMgByDrug(injections, targetDate, weighIns)
    .reduce((sum, amount) => sum + amount.amountMg, 0);
  return roundMg(total);
}

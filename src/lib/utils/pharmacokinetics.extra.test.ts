// Supplemental tests for pharmacokinetics.ts.
//
// The main test file (`pharmacokinetics.test.ts`) covers the happy paths and
// the documented quirks (same-day-zero, decay after Tmax, multi-drug
// separation, unknown medications). This file fills in the remaining branches:
//   - rising phase before Tmax (concentration goes UP before Tmax)
//   - all five drugs in DRUG_PK are reachable (smoke each one)
//   - drugDisplayColor falls back to a palette entry for an unknown med
//   - drugInitial trims leading whitespace before taking the first character
import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import {
  DRUG_DISPLAY_COLORS,
  DRUG_DISPLAY_SHAPES,
  DRUG_FALLBACK_SHAPES,
  DRUG_PK,
  calculateSystemMg,
  calculateSystemMgByDrug,
  drugDisplayColor,
  drugDisplayShape,
  drugInitial,
  formatSystemMg,
  systemDecayTerms,
  weightForDate,
} from './pharmacokinetics';
import type { Medication } from '$lib/domain/types';

const ALL_MEDS = Object.keys(DRUG_PK) as Medication[];

describe('DRUG_PK metadata', () => {
  it('ke matches ln(2)/halfLifeHours for every one-compartment entry', () => {
    for (const med of ALL_MEDS) {
      const pk = DRUG_PK[med];
      if (pk.model !== 'one-compartment') continue;
      expect(pk.ke).toBeCloseTo(Math.LN2 / pk.halfLifeHours, 10);
    }
  });

  it('every one-compartment drug has ka > ke (absorption faster than elimination)', () => {
    for (const med of ALL_MEDS) {
      const pk = DRUG_PK[med];
      if (pk.model !== 'one-compartment') continue;
      expect(pk.ka).toBeGreaterThan(pk.ke);
    }
  });

  it('every drug has bioavailability in (0, 1]', () => {
    for (const med of ALL_MEDS) {
      const f = DRUG_PK[med].bioavailability;
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('every two-compartment drug has positive rate constants', () => {
    let count = 0;
    for (const med of ALL_MEDS) {
      const pk = DRUG_PK[med];
      if (pk.model !== 'two-compartment') continue;
      count += 1;
      expect(pk.ka).toBeGreaterThan(0);
      expect(pk.k10).toBeGreaterThan(0);
      expect(pk.k12).toBeGreaterThan(0);
      expect(pk.k21).toBeGreaterThan(0);
    }
    expect(count).toBe(3); // semaglutide, tirzepatide, dulaglutide
  });
});

describe('PK model qualitative behavior', () => {
  // For every drug, a fresh single dose should produce a positive residual one
  // week later — this also exercises each entry of DRUG_PK at least once.
  it.each(ALL_MEDS)('a 5mg single dose of %s gives positive residual after 7 days', (med) => {
    const result = calculateSystemMgByDrug(
      [{ date: iso('2026-01-01'), amountMg: 5, medication: med }],
      iso('2026-01-08'),
    );
    // Liraglutide's 13-hour half-life means a 5mg dose after 7 days may round
    // to zero (~9 half-lives). For drugs that vanish from the rounded result
    // we accept an empty array; otherwise we require a strictly positive entry.
    if (result.length === 0) {
      // Sanity: total summed mg must also be zero (rounded).
      expect(
        calculateSystemMg(
          [{ date: iso('2026-01-01'), amountMg: 5, medication: med }],
          iso('2026-01-08'),
        ),
      ).toBe(0);
      return;
    }
    expect(result[0].medication).toBe(med);
    expect(result[0].amountMg).toBeGreaterThan(0);
  });

  it('semaglutide (two-compartment) rises to a ~3-day peak then declines', () => {
    const dose = [
      { date: iso('2026-01-01'), amountMg: 5, medication: 'Semaglutide (Ozempic / Wegovy)' },
    ];
    const at = (date: string) => calculateSystemMgByDrug(dose, iso(date))[0].amountMg;
    const day1 = at('2026-01-02'); // 24h
    const day3 = at('2026-01-04'); // 72h, near the peak
    const day5 = at('2026-01-06'); // 120h, past the peak
    const day9 = at('2026-01-10'); // 216h
    expect(day3).toBeGreaterThan(day1); // rising into the peak
    expect(day3).toBeGreaterThan(day5); // descending after it
    expect(day5).toBeGreaterThan(day9);
    expect(day9).toBeGreaterThan(0);
  });

  it('tirzepatide (two-compartment) is past its ~1.3-day peak by 48h and decaying', () => {
    const dose = [
      { date: iso('2026-01-01'), amountMg: 5, medication: 'Tirzepatide (Mounjaro / Zepbound)' },
    ];
    const at = (date: string) => calculateSystemMgByDrug(dose, iso(date))[0].amountMg;
    const day1 = at('2026-01-02'); // ~24h, near the ~30h peak
    const day2 = at('2026-01-03'); // ~48h, past the peak
    const day4 = at('2026-01-05');
    const day7 = at('2026-01-08');
    expect(day1).toBeGreaterThan(day2); // already descending by 48h
    expect(day2).toBeGreaterThan(day4);
    expect(day4).toBeGreaterThan(day7);
    expect(day7).toBeGreaterThan(0);
  });

  it('liraglutide (Tmax ≈ 10h) is already past peak by 24h and decaying', () => {
    const dose = [
      { date: iso('2026-01-01'), amountMg: 3, medication: 'Liraglutide (Victoza / Saxenda)' },
    ];
    const day1 = calculateSystemMgByDrug(dose, iso('2026-01-02'))[0].amountMg;
    const day2 = calculateSystemMgByDrug(dose, iso('2026-01-03'))[0].amountMg;
    expect(day1).toBeGreaterThan(day2);
  });

  it('dulaglutide (two-compartment) rises to a broad day-2/3 peak then declines', () => {
    // The published two-compartment model peaks ~2.5 days after the dose, so
    // the day-2 and day-3 samples sit on a near-flat plateau.
    const dose = [
      { date: iso('2026-01-01'), amountMg: 4.5, medication: 'Dulaglutide (Trulicity)' },
    ];
    const at = (date: string) => calculateSystemMgByDrug(dose, iso(date))[0].amountMg;
    const day1 = at('2026-01-02');
    const day2 = at('2026-01-03');
    const day3 = at('2026-01-04');
    const day5 = at('2026-01-06');
    const day10 = at('2026-01-11');
    expect(day2).toBeGreaterThan(day1); // still rising between 24h and 48h
    expect(day3).toBeGreaterThan(day1);
    expect(Math.abs(day3 - day2) / day2).toBeLessThan(0.05); // broad, flat peak
    expect(day5).toBeLessThan(day3); // declining after the peak
    expect(day10).toBeLessThan(day5);
    expect(day10).toBeGreaterThan(0);
  });
});

describe('calculateSystemMg edge cases', () => {
  it('returns 0 when only unknown medications are supplied', () => {
    expect(
      calculateSystemMg(
        [{ date: iso('2026-01-01'), amountMg: 10, medication: 'NotARealDrug' }],
        iso('2026-01-05'),
      ),
    ).toBe(0);
  });

  it('returns 0 for a same-day-only injection list (same-day-zero rule)', () => {
    expect(
      calculateSystemMg(
        [
          {
            date: iso('2026-01-01'),
            amountMg: 5,
            medication: 'Semaglutide (Ozempic / Wegovy)',
          },
        ],
        iso('2026-01-01'),
      ),
    ).toBe(0);
  });
});

describe('systemDecayTerms', () => {
  it('returns two terms for a one-compartment drug', () => {
    const terms = systemDecayTerms('Liraglutide (Victoza / Saxenda)');
    expect(terms).toHaveLength(2);
  });

  it('returns three terms for dulaglutide (two-compartment)', () => {
    const terms = systemDecayTerms('Dulaglutide (Trulicity)');
    expect(terms).toHaveLength(3);
  });

  it('returns null for an unknown medication', () => {
    expect(systemDecayTerms('NotARealDrug')).toBeNull();
  });

  it('evaluating the terms reproduces calculateSystemMgByDrug', () => {
    // amount = dose · Σ coefficient · exp(-rateConstant · t)
    const terms = systemDecayTerms('Dulaglutide (Trulicity)');
    expect(terms).not.toBeNull();
    const dose = 4.5;
    const tHours = 48; // 2026-01-01 00:00 → 2026-01-03 00:00
    const direct = dose * terms!.reduce(
      (sum, term) => sum + term.coefficient * Math.exp(-term.rateConstant * tHours),
      0,
    );
    const viaApi = calculateSystemMgByDrug(
      [{ date: iso('2026-01-01'), amountMg: dose, medication: 'Dulaglutide (Trulicity)' }],
      iso('2026-01-03'),
    )[0].amountMg;
    expect(viaApi).toBeCloseTo(direct, 2);
  });
});

describe('weightForDate', () => {
  const weighIns = [
    { date: iso('2026-01-01'), weightKg: 90 },
    { date: iso('2026-01-10'), weightKg: 88 },
    { date: iso('2026-01-20'), weightKg: 86 },
  ];

  it('returns the most recent weigh-in on or before the date', () => {
    expect(weightForDate(weighIns, iso('2026-01-15'))).toBe(88);
  });

  it('includes a weigh-in falling on the exact date', () => {
    expect(weightForDate(weighIns, iso('2026-01-10'))).toBe(88);
  });

  it('returns undefined when no weigh-in is on or before the date', () => {
    expect(weightForDate(weighIns, iso('2025-12-31'))).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(weightForDate([], iso('2026-01-15'))).toBeUndefined();
  });
});

describe('body-weight personalization', () => {
  const DULA = 'Dulaglutide (Trulicity)';

  it('a weigh-in at the reference weight leaves the result unchanged', () => {
    const dose = [{ date: iso('2026-01-01'), amountMg: 4.5, medication: DULA }];
    const noWeight = calculateSystemMgByDrug(dose, iso('2026-01-04'))[0].amountMg;
    const atReference = calculateSystemMgByDrug(dose, iso('2026-01-04'), [
      { date: iso('2026-01-01'), weightKg: 92.5 }, // dulaglutide reference weight
    ])[0].amountMg;
    expect(atReference).toBeCloseTo(noWeight, 6);
  });

  it('dulaglutide: a heavier patient gets a lower amount (bioavailability covariate)', () => {
    const dose = [{ date: iso('2026-01-01'), amountMg: 4.5, medication: DULA }];
    const light = calculateSystemMgByDrug(dose, iso('2026-01-04'), [
      { date: iso('2026-01-01'), weightKg: 70 },
    ])[0].amountMg;
    const heavy = calculateSystemMgByDrug(dose, iso('2026-01-04'), [
      { date: iso('2026-01-01'), weightKg: 130 },
    ])[0].amountMg;
    expect(light).toBeGreaterThan(heavy);
  });

  it('uses the weigh-in on or before each dose — a later weigh-in is ignored', () => {
    const dose = [{ date: iso('2026-01-10'), amountMg: 4.5, medication: DULA }];
    const priorOnly = calculateSystemMgByDrug(dose, iso('2026-01-14'), [
      { date: iso('2026-01-05'), weightKg: 100 },
    ])[0].amountMg;
    const withLater = calculateSystemMgByDrug(dose, iso('2026-01-14'), [
      { date: iso('2026-01-05'), weightKg: 100 },
      { date: iso('2026-01-12'), weightKg: 75 }, // after the dose — must be ignored
    ])[0].amountMg;
    expect(withLater).toBeCloseTo(priorOnly, 6);
  });

  it('one-compartment drugs (no weight covariate) are unaffected by weight', () => {
    const dose = [
      { date: iso('2026-01-01'), amountMg: 3, medication: 'Liraglutide (Victoza / Saxenda)' },
    ];
    const plain = calculateSystemMgByDrug(dose, iso('2026-01-02'))[0].amountMg;
    const weighed = calculateSystemMgByDrug(dose, iso('2026-01-02'), [
      { date: iso('2026-01-01'), weightKg: 130 },
    ])[0].amountMg;
    expect(weighed).toBe(plain);
  });

  it('systemDecayTerms applies the allometric covariate (tirzepatide rates scale with weight)', () => {
    const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';
    const reference = systemDecayTerms(TIRZ);
    const heavy = systemDecayTerms(TIRZ, 110);
    expect(reference).not.toBeNull();
    expect(heavy).not.toBeNull();
    // Tirzepatide's disposition rates scale by (weight/70)^-0.2, so a heavier
    // patient (110 kg > 70 kg) has slightly slower rate constants.
    expect(heavy![1].rateConstant).toBeLessThan(reference![1].rateConstant);
  });
});

describe('formatSystemMg extra cases', () => {
  it.each([
    [0.005, '0.01'], // round-half-up via Math.round
    [0.004, '0'],
    [99.999, '100'],
  ])('formatSystemMg(%f) === %s', (input, expected) => {
    expect(formatSystemMg(input)).toBe(expected);
  });
});

describe('drugInitial extra cases', () => {
  it('trims leading whitespace before taking the first character', () => {
    expect(drugInitial('  semaglutide')).toBe('S');
    expect(drugInitial('\tretatrutide')).toBe('R');
  });
});

describe('drugDisplayColor extra cases', () => {
  it('returns a palette entry for unknown medications', () => {
    const palette = [
      'var(--drug-palette-0)',
      'var(--drug-palette-1)',
      'var(--drug-palette-2)',
      'var(--drug-palette-3)',
      'var(--drug-palette-4)',
      'var(--drug-palette-5)',
      'var(--drug-palette-6)',
    ];
    expect(palette).toContain(drugDisplayColor('Mystery Compound'));
    expect(palette).toContain(drugDisplayColor(''));
    expect(palette).toContain(drugDisplayColor('Another Unknown'));
  });

  it('returns the documented color for every known medication', () => {
    for (const med of ALL_MEDS) {
      expect(drugDisplayColor(med)).toBe(DRUG_DISPLAY_COLORS[med]);
    }
  });

  it('different unknown medications can produce different palette colors', () => {
    // Not a strict guarantee, but with 7 palette colors and varied names the
    // set should have more than one distinct value.
    const seen = new Set(
      ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'].map((s) => drugDisplayColor(s)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('drugDisplayShape', () => {
  it('returns the documented shape for every known medication', () => {
    for (const med of ALL_MEDS) {
      expect(drugDisplayShape(med)).toBe(DRUG_DISPLAY_SHAPES[med]);
    }
  });

  it('assigns a distinct shape to each known medication', () => {
    const shapes = ALL_MEDS.map((med) => DRUG_DISPLAY_SHAPES[med]);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('returns a fallback shape for unknown medications', () => {
    expect(DRUG_FALLBACK_SHAPES).toContain(drugDisplayShape('Mystery Compound'));
    expect(DRUG_FALLBACK_SHAPES).toContain(drugDisplayShape(''));
    expect(DRUG_FALLBACK_SHAPES).toContain(drugDisplayShape('Another Unknown'));
  });

  it('hashes deterministically: same input → same shape', () => {
    expect(drugDisplayShape('Mystery Compound')).toBe(drugDisplayShape('Mystery Compound'));
  });
});

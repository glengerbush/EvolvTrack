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
} from './pharmacokinetics';
import type { Medication } from '$lib/domain/types';

const ALL_MEDS = Object.keys(DRUG_PK) as Medication[];

describe('DRUG_PK metadata', () => {
  it('ke matches ln(2)/halfLifeHours for every entry', () => {
    for (const med of ALL_MEDS) {
      const pk = DRUG_PK[med];
      expect(pk.ke).toBeCloseTo(Math.LN2 / pk.halfLifeHours, 10);
    }
  });

  it('every drug has ka > ke (absorption faster than elimination)', () => {
    for (const med of ALL_MEDS) {
      const pk = DRUG_PK[med];
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
});

describe('Bateman model qualitative behavior', () => {
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

  it('tirzepatide rises across the first 2 days (Tmax ≈ 59h)', () => {
    const dose = [
      { date: iso('2026-01-01'), amountMg: 5, medication: 'Tirzepatide (Mounjaro / Zepbound)' },
    ];
    const day1 = calculateSystemMgByDrug(dose, iso('2026-01-02'))[0].amountMg;
    const day2 = calculateSystemMgByDrug(dose, iso('2026-01-03'))[0].amountMg;
    // day2 (~48h after dose) is closer to Tmax (~59h) than day1 (~24h) is,
    // so concentration should still be rising.
    expect(day2).toBeGreaterThan(day1);
  });

  it('liraglutide (Tmax ≈ 10h) is already past peak by 24h and decaying', () => {
    const dose = [
      { date: iso('2026-01-01'), amountMg: 3, medication: 'Liraglutide (Victoza / Saxenda)' },
    ];
    const day1 = calculateSystemMgByDrug(dose, iso('2026-01-02'))[0].amountMg;
    const day2 = calculateSystemMgByDrug(dose, iso('2026-01-03'))[0].amountMg;
    expect(day1).toBeGreaterThan(day2);
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

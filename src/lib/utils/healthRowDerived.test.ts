import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import {
  calculateDay,
  calculateLoss,
  cloneRow,
  enrichSystemAmounts,
  formatSystemAmounts,
  parseWeight,
  recalculateDerived,
} from '$lib/utils/healthRowDerived';
import type { HealthInputRow, HealthSystemAmount } from '$lib/stores/healthTypes';

import type { Medication } from '$lib/domain/types';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' satisfies Medication;
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)' satisfies Medication;

// Accept a plain string for `date` in test fixtures and brand it inside the
// helper. `Omit<...>` strips the partial's branded `date?` field so the
// intersection with `{ date: string }` doesn't collapse back to `IsoDate`.
function row(overrides: Omit<Partial<HealthInputRow>, 'date'> & { date: string }): HealthInputRow {
  return {
    day: '',
    system: '',
    systemAmounts: [],
    dose: '',
    dosePlanned: false,
    doseSkipped: false,
    medication: '',
    weight: '',
    wellness: '',
    loss: '',
    symptoms: [],
    shotLocation: '',
    notes: '',
    ...overrides,
    date: iso(overrides.date),
  };
}

describe('parseWeight', () => {
  it('returns the parsed number for a valid input', () => {
    expect(parseWeight('180.5')).toBe(180.5);
  });
  it('returns null for empty or non-numeric input', () => {
    expect(parseWeight('')).toBeNull();
    expect(parseWeight('abc')).toBeNull();
  });
});

describe('calculateLoss', () => {
  it('returns previous minus current to 1 decimal', () => {
    expect(calculateLoss('178', '180')).toBe('2.0');
  });
  it('returns empty string if either side is unparseable', () => {
    expect(calculateLoss('', '180')).toBe('');
    expect(calculateLoss('178', '')).toBe('');
  });
});

describe('calculateDay', () => {
  it('returns the weekday name for an ISO date', () => {
    // 2026-05-10 is a Sunday.
    expect(calculateDay('2026-05-10')).toBe('Sunday');
  });
  it('returns empty string for blank input', () => {
    expect(calculateDay('')).toBe('');
  });
});

describe('recalculateDerived — scope: local', () => {
  it('returns clones without computing any derived fields', () => {
    const input = [
      row({ date: '2026-05-08', weight: '180', dose: '5', medication: SEMA }),
      row({ date: '2026-05-09', notes: 'easy day' }),
    ];
    const result = recalculateDerived(input, { defaultMedication: SEMA, scope: 'local' });

    // The clone does not populate day/loss/system on rows that came in without them.
    expect(result[0].day).toBe('');
    expect(result[0].loss).toBe('');
    expect(result[0].system).toBe('');
    expect(result[0]).not.toBe(input[0]);
  });

  it('clones nested arrays so callers can mutate safely', () => {
    const input = [row({ date: '2026-05-08', symptoms: ['nausea'] })];
    const [out] = recalculateDerived(input, { defaultMedication: SEMA, scope: 'local' });
    out.symptoms.push('headache');
    expect(input[0].symptoms).toEqual(['nausea']);
  });
});

describe('recalculateDerived — scope: full', () => {
  it('populates day and loss chain in chronological order', () => {
    const input = [
      row({ date: '2026-05-10', weight: '178' }),
      row({ date: '2026-05-08', weight: '180' }),
      row({ date: '2026-05-09', weight: '179' }),
    ];
    const result = recalculateDerived(input, { defaultMedication: SEMA, preserveOrder: true });

    // result[0] is the original 05-10 row; should have loss vs 05-09's weight.
    expect(result[0].date).toBe('2026-05-10');
    expect(result[0].loss).toBe('1.0');
    expect(result[1].date).toBe('2026-05-08');
    expect(result[1].loss).toBe('');
    expect(result[2].date).toBe('2026-05-09');
    expect(result[2].loss).toBe('1.0');
    expect(result[0].day).toBe('Sunday');
  });

  it('returns newest-first when preserveOrder is false', () => {
    const input = [
      row({ date: '2026-05-08' }),
      row({ date: '2026-05-10' }),
      row({ date: '2026-05-09' }),
    ];
    const result = recalculateDerived(input, { defaultMedication: SEMA });
    expect(result.map((r) => r.date)).toEqual(['2026-05-10', '2026-05-09', '2026-05-08']);
  });

  it('populates system amounts for rows that follow an injection', () => {
    const input = [
      row({ date: '2026-05-08', dose: '5', medication: SEMA }),
      row({ date: '2026-05-15' }),
    ];
    const result = recalculateDerived(input, { defaultMedication: SEMA, preserveOrder: true });

    // Same-day-zero rule: the injection-day row's residual is evaluated at
    // 00:00 *before* that day's dose lands, so calculateSystemMgByDrug returns
    // [] and the formatted system string is blank.
    expect(result[0].systemAmounts).toEqual([]);
    expect(result[0].system).toBe('');
    // The later row should have a non-empty system from the Bateman curve.
    expect(result[1].systemAmounts.length).toBe(1);
    expect(result[1].systemAmounts[0].medication).toBe(SEMA);
  });

  it('skipped doses do not contribute to PK and leave system blank', () => {
    const input = [
      row({ date: '2026-05-08', dose: '5', medication: SEMA, doseSkipped: true }),
      row({ date: '2026-05-15' }),
    ];
    const result = recalculateDerived(input, { defaultMedication: SEMA, preserveOrder: true });

    expect(result[0].systemAmounts).toEqual([]);
    expect(result[0].system).toBe('');
    // No active injection ⇒ no system on the later row either.
    expect(result[1].systemAmounts).toEqual([]);
  });

  it('falls back to defaultMedication when an injection has no medication set', () => {
    const input = [
      row({ date: '2026-05-08', dose: '5', medication: '' }),
      row({ date: '2026-05-15' }),
    ];
    const result = recalculateDerived(input, { defaultMedication: SEMA, preserveOrder: true });
    expect(result[1].systemAmounts[0]?.medication).toBe(SEMA);
  });

  it('appends a medication initial when more than one medication appears', () => {
    const input = [
      row({ date: '2026-05-01', dose: '5', medication: SEMA }),
      row({ date: '2026-05-08', dose: '7', medication: TIRZ }),
      row({ date: '2026-05-15' }),
    ];
    const result = recalculateDerived(input, { defaultMedication: SEMA, preserveOrder: true });

    // System string for the trailing date should carry letter suffixes.
    expect(result[2].system).toMatch(/[ST]$/m);
  });
});

describe('recalculateDerived — boundary optimization', () => {
  it('leaves pre-boundary rows untouched for fields that depend on prior data', () => {
    const stale: HealthInputRow = row({
      date: '2026-05-01',
      weight: '180',
      day: 'STALE-DAY',
      loss: 'STALE-LOSS',
    });
    const input = [stale, row({ date: '2026-05-10', weight: '178' })];

    const result = recalculateDerived(input, {
      defaultMedication: SEMA,
      earliestChangedDate: iso('2026-05-10'),
      preserveOrder: true,
    });

    // Pre-boundary row is preserved verbatim (apart from system reformat).
    expect(result[0].day).toBe('STALE-DAY');
    expect(result[0].loss).toBe('STALE-LOSS');
    // Post-boundary row is freshly computed; loss seeded from pre-boundary weight.
    expect(result[1].loss).toBe('2.0');
  });

  it('reformats system on pre-boundary rows when showMedicationLetters flips', () => {
    // A pre-boundary SEMA dose already enriched with single-medication system
    // text ('4'), plus a new TIRZ dose on/after the boundary. The TIRZ dose
    // flips showMedicationLetters to true, so the pre-boundary system string
    // should re-format from '4' to '4 S'.
    const preBoundary: HealthInputRow = row({
      date: '2026-05-01',
      dose: '5',
      medication: SEMA,
      system: '4',
      systemAmounts: [
        { medication: SEMA, amountMg: 4, color: '#000', initial: 'S' },
      ],
    });
    const input = [
      preBoundary,
      row({ date: '2026-05-08', dose: '5', medication: TIRZ }),
    ];
    const result = recalculateDerived(input, {
      defaultMedication: SEMA,
      earliestChangedDate: iso('2026-05-08'),
      preserveOrder: true,
    });

    // Pre-boundary system now carries the S suffix because TIRZ is also present.
    expect(result[0].system).toContain('S');
  });
});

describe('recalculateDerived — scope: weight', () => {
  it('recomputes both the loss chain and PK (a weight change now affects the curve)', () => {
    // Body-weight personalization means a weight change shifts the PK curve, so
    // 'weight' scope can no longer reuse stale system values — it is a full
    // recompute.
    const dosed: HealthInputRow = row({
      date: '2026-05-10',
      weight: '178',
      dose: '5',
      medication: SEMA,
      system: 'STALE-SYS',
      systemAmounts: [],
    });
    const result = recalculateDerived(
      [row({ date: '2026-05-08', weight: '180', dose: '5', medication: SEMA }), dosed],
      {
        defaultMedication: SEMA,
        earliestChangedDate: iso('2026-05-08'),
        scope: 'weight',
        preserveOrder: true,
      },
    );
    expect(result[1].loss).toBe('2.0'); // loss chain recomputed
    expect(result[1].system).not.toBe('STALE-SYS'); // PK recomputed, not reused
    expect(result[1].systemAmounts.length).toBeGreaterThan(0);
  });
});

describe('recalculateDerived — scope: pk', () => {
  it('recomputes system but reuses existing loss/day', () => {
    const preserved: HealthInputRow = row({
      date: '2026-05-15',
      day: 'STALE-DAY',
      loss: 'STALE-LOSS',
    });
    const result = recalculateDerived(
      [row({ date: '2026-05-08', dose: '5', medication: SEMA }), preserved],
      {
        defaultMedication: SEMA,
        earliestChangedDate: iso('2026-05-08'),
        scope: 'pk',
        preserveOrder: true,
      },
    );

    expect(result[1].day).toBe('STALE-DAY');
    expect(result[1].loss).toBe('STALE-LOSS');
    expect(result[1].systemAmounts.length).toBeGreaterThan(0);
  });
});

describe('recalculateDerived — immutability', () => {
  it('does not mutate the input rows', () => {
    const original = row({ date: '2026-05-08', weight: '180', symptoms: ['nausea'] });
    const snapshot = JSON.stringify(original);
    recalculateDerived([original], { defaultMedication: SEMA });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('recalculateDerived — edge cases', () => {
  it('returns an empty array for empty input', () => {
    expect(recalculateDerived([], { defaultMedication: SEMA })).toEqual([]);
  });

  it('treats earliestChangedDate beyond every row as "nothing to recompute"', () => {
    // findIndex returns -1 → recomputeFromIdx === ascending.length, so every
    // row is in the pre-boundary branch and is preserved verbatim.
    const stale = row({
      date: '2026-05-01',
      weight: '180',
      day: 'STALE-DAY',
      loss: 'STALE-LOSS',
    });
    const [out] = recalculateDerived([stale], {
      defaultMedication: SEMA,
      earliestChangedDate: iso('2099-01-01'),
      preserveOrder: true,
    });
    expect(out.day).toBe('STALE-DAY');
    expect(out.loss).toBe('STALE-LOSS');
  });

  it('weight scope reformats system on pre-boundary rows (it now behaves like full)', () => {
    // 'weight' scope is treated as a full recompute, so pre-boundary rows get
    // their system string reformatted when showMedicationLetters flips.
    const preBoundary = row({
      date: '2026-05-01',
      dose: '5',
      medication: SEMA,
      system: '4',
      systemAmounts: [{ medication: SEMA, amountMg: 4, color: '#000', initial: 'S' }],
    });
    const result = recalculateDerived(
      [preBoundary, row({ date: '2026-05-08', dose: '5', medication: TIRZ })],
      {
        defaultMedication: SEMA,
        earliestChangedDate: iso('2026-05-08'),
        scope: 'weight',
        preserveOrder: true,
      },
    );
    expect(result[0].system).toBe('4 S');
  });
});

describe('cloneRow', () => {
  it('returns a new object that does not share references', () => {
    const original = row({ date: '2026-05-08', symptoms: ['nausea'] });
    const cloned = cloneRow(original);
    expect(cloned).not.toBe(original);
    expect(cloned).toEqual(original);
  });

  it('deep-clones the symptoms array (mutation on the clone is isolated)', () => {
    const original = row({ date: '2026-05-08', symptoms: ['nausea'] });
    const cloned = cloneRow(original);
    cloned.symptoms.push('headache');
    expect(original.symptoms).toEqual(['nausea']);
  });

  it('deep-clones the systemAmounts array', () => {
    const original = row({
      date: '2026-05-08',
      systemAmounts: [{ medication: SEMA, amountMg: 4, color: '#000', initial: 'S' }],
    });
    const cloned = cloneRow(original);
    cloned.systemAmounts.push({ medication: TIRZ, amountMg: 7, color: '#111', initial: 'T' });
    expect(original.systemAmounts).toHaveLength(1);
  });
});

describe('enrichSystemAmounts', () => {
  it('adds color and initial fields derived from the medication name', () => {
    const enriched = enrichSystemAmounts([{ medication: SEMA, amountMg: 4 }]);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]).toMatchObject({ medication: SEMA, amountMg: 4 });
    expect(enriched[0].initial).toBe('S');
    expect(enriched[0].color).toMatch(/^var\(--drug-/);
  });

  it('returns an empty array for empty input', () => {
    expect(enrichSystemAmounts([])).toEqual([]);
  });
});

describe('formatSystemAmounts', () => {
  const amounts: HealthSystemAmount[] = [
    { medication: SEMA, amountMg: 4, color: '#000', initial: 'S' },
    { medication: TIRZ, amountMg: 7, color: '#111', initial: 'T' },
  ];

  it('joins entries with a newline and omits letters when showMedicationLetters is false', () => {
    expect(formatSystemAmounts(amounts, false)).toBe('4\n7');
  });

  it('appends the medication initial when showMedicationLetters is true', () => {
    expect(formatSystemAmounts(amounts, true)).toBe('4 S\n7 T');
  });

  it('returns an empty string for no amounts', () => {
    expect(formatSystemAmounts([], false)).toBe('');
    expect(formatSystemAmounts([], true)).toBe('');
  });
});

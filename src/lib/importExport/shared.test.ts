import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import {
  cleanOptionalString,
  cleanString,
  makeHealthEntry,
  makePrescription,
  mapObjectByNormalizedHeaders,
  mergeWarnings,
  normalizeHeader,
  normalizeMedication,
  parseBoolean,
  parseDateKey,
  parseDateTime,
  parseList,
  parseNumber,
  pickField,
  round,
  weightFromStoredLbs,
  weightToStoredLbs,
} from './shared';

describe('cleanString', () => {
  it('trims whitespace', () => {
    expect(cleanString('  hello  ')).toBe('hello');
  });

  it('returns empty for null/undefined', () => {
    expect(cleanString(null)).toBe('');
    expect(cleanString(undefined)).toBe('');
  });

  it('coerces numbers and booleans to string', () => {
    expect(cleanString(42)).toBe('42');
    expect(cleanString(true)).toBe('true');
  });
});

describe('cleanOptionalString', () => {
  it('returns undefined for empty strings', () => {
    expect(cleanOptionalString('   ')).toBeUndefined();
    expect(cleanOptionalString('')).toBeUndefined();
    expect(cleanOptionalString(null)).toBeUndefined();
  });

  it('returns the trimmed value otherwise', () => {
    expect(cleanOptionalString('  hi ')).toBe('hi');
  });
});

describe('parseNumber', () => {
  it('passes through finite numbers', () => {
    expect(parseNumber(5)).toBe(5);
    expect(parseNumber(0)).toBe(0);
    expect(parseNumber(-3.5)).toBe(-3.5);
  });

  it('rejects NaN and Infinity', () => {
    expect(parseNumber(NaN)).toBeUndefined();
    expect(parseNumber(Infinity)).toBeUndefined();
  });

  it('strips currency, comma, and unit suffixes', () => {
    expect(parseNumber('$1,200.50')).toBe(1200.5);
    expect(parseNumber('5 mg')).toBe(5);
    expect(parseNumber('200 lbs')).toBe(200);
    expect(parseNumber('80 kg')).toBe(80);
    expect(parseNumber('15 units')).toBe(15);
    expect(parseNumber('2.5 ml')).toBe(2.5);
  });

  it('returns undefined for unparseable input', () => {
    expect(parseNumber('not-a-number')).toBeUndefined();
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber(null)).toBeUndefined();
  });
});

describe('parseBoolean', () => {
  it('passes through booleans', () => {
    expect(parseBoolean(true)).toBe(true);
    expect(parseBoolean(false)).toBe(false);
  });

  it.each(['true', 'yes', 'Y', '1', 'planned', 'Scheduled'])(
    'recognizes %s as true',
    (input) => {
      expect(parseBoolean(input)).toBe(true);
    },
  );

  it.each(['false', 'no', 'N', '0', 'confirmed', 'taken', 'complete', 'completed'])(
    'recognizes %s as false',
    (input) => {
      expect(parseBoolean(input)).toBe(false);
    },
  );

  it('returns undefined for empty or unrecognized strings', () => {
    expect(parseBoolean('')).toBeUndefined();
    expect(parseBoolean('maybe')).toBeUndefined();
    expect(parseBoolean(null)).toBeUndefined();
  });
});

describe('parseDateKey', () => {
  it('parses Date objects', () => {
    const date = new Date(Date.UTC(2026, 4, 10));
    expect(parseDateKey(date)).toBe('2026-05-10');
  });

  it('returns undefined for an Invalid Date', () => {
    expect(parseDateKey(new Date('not a date'))).toBeUndefined();
  });

  it('converts Excel serial numbers (1899-12-30 epoch)', () => {
    // Excel serial 44927 = 2023-01-01
    expect(parseDateKey(44927)).toBe('2023-01-01');
  });

  it('parses ISO date strings', () => {
    expect(parseDateKey('2026-05-10')).toBe('2026-05-10');
    expect(parseDateKey('2026-05-10T12:34:56Z')).toBe('2026-05-10');
  });

  it('parses M/D/YY and M/D/YYYY slash dates', () => {
    expect(parseDateKey('5/10/2026')).toBe('2026-05-10');
    expect(parseDateKey('05/10/26')).toBe('2026-05-10');
    expect(parseDateKey('1/5/2026')).toBe('2026-01-05');
  });

  it('falls back to Date parsing for natural-language dates', () => {
    // Use a UTC-anchored form to avoid timezone drift in CI.
    const result = parseDateKey('2026-05-10T00:00:00Z');
    expect(result).toBe('2026-05-10');
  });

  it('returns undefined for garbage strings', () => {
    expect(parseDateKey('garbage')).toBeUndefined();
    expect(parseDateKey('')).toBeUndefined();
    expect(parseDateKey(null)).toBeUndefined();
    expect(parseDateKey(undefined)).toBeUndefined();
  });

  it('rejects overflow ISO dates (month 13)', () => {
    expect(parseDateKey('2026-13-01')).toBeUndefined();
  });

  it('handles non-finite numbers', () => {
    expect(parseDateKey(NaN)).toBeUndefined();
    expect(parseDateKey(Infinity)).toBeUndefined();
  });
});

describe('parseDateTime', () => {
  it('returns ISO timestamp for a Date object', () => {
    const date = new Date('2026-05-10T12:34:56.000Z');
    expect(parseDateTime(date)).toBe('2026-05-10T12:34:56.000Z');
  });

  it('returns undefined for an Invalid Date', () => {
    expect(parseDateTime(new Date('totally bogus'))).toBeUndefined();
  });

  it('parses ISO strings', () => {
    expect(parseDateTime('2026-05-10T00:00:00Z')).toBe('2026-05-10T00:00:00.000Z');
  });

  it('returns undefined for empty or garbage input', () => {
    expect(parseDateTime('')).toBeUndefined();
    expect(parseDateTime(null)).toBeUndefined();
    expect(parseDateTime('not-a-date')).toBeUndefined();
  });
});

describe('parseList', () => {
  it('preserves arrays and trims/cleans elements', () => {
    expect(parseList(['a', ' b ', '', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('splits delimited strings on , ; |', () => {
    expect(parseList('nausea, fatigue; headache | dry mouth')).toEqual([
      'nausea',
      'fatigue',
      'headache',
      'dry mouth',
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList(null)).toEqual([]);
  });
});

describe('normalizeHeader', () => {
  it('lowercases and splits camelCase into words', () => {
    expect(normalizeHeader('weightLbs')).toBe('weight lbs');
  });

  it('strips parenthesised qualifiers and punctuation', () => {
    expect(normalizeHeader('Weight (lbs)')).toBe('weight');
    expect(normalizeHeader('shot_location')).toBe('shot location');
  });
});

describe('pickField', () => {
  it('finds a field by exact key', () => {
    const row = { weight: 180, dose: 5 };
    expect(pickField(row, ['weight'])).toBe(180);
  });

  it('falls back to normalized header lookup', () => {
    const row = { 'Weight (lbs)': 180 };
    expect(pickField(row, ['weight'])).toBe(180);
  });

  it('returns undefined when no candidate matches', () => {
    expect(pickField({ foo: 1 }, ['bar'])).toBeUndefined();
  });
});

describe('mapObjectByNormalizedHeaders', () => {
  it('rekeys an object using normalized headers', () => {
    const row = { 'Weight (lbs)': 180, 'Shot Location': 'thigh' };
    expect(mapObjectByNormalizedHeaders(row)).toEqual({
      weight: 180,
      'shot location': 'thigh',
    });
  });
});

describe('normalizeMedication', () => {
  it('passes through known canonical medications', () => {
    expect(normalizeMedication('Semaglutide (Ozempic / Wegovy)')).toBe(
      'Semaglutide (Ozempic / Wegovy)',
    );
  });

  it.each([
    ['ozempic', 'Semaglutide (Ozempic / Wegovy)'],
    ['Wegovy', 'Semaglutide (Ozempic / Wegovy)'],
    ['Rybelsus', 'Semaglutide (Ozempic / Wegovy)'],
    ['semaglutide', 'Semaglutide (Ozempic / Wegovy)'],
    ['Mounjaro', 'Tirzepatide (Mounjaro / Zepbound)'],
    ['zepbound', 'Tirzepatide (Mounjaro / Zepbound)'],
    ['tirzepatide', 'Tirzepatide (Mounjaro / Zepbound)'],
    ['Trulicity', 'Dulaglutide (Trulicity)'],
    ['Victoza', 'Liraglutide (Victoza / Saxenda)'],
    ['Saxenda', 'Liraglutide (Victoza / Saxenda)'],
    ['retatrutide', 'Retatrutide'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeMedication(input)).toBe(expected);
  });

  it('returns empty string for unknown / empty input', () => {
    expect(normalizeMedication('Aspirin')).toBe('');
    expect(normalizeMedication('')).toBe('');
    expect(normalizeMedication(null)).toBe('');
  });
});

describe('weightToStoredLbs / weightFromStoredLbs', () => {
  it('round-trips a kg-hinted input back to its kg display value', () => {
    const stored = weightToStoredLbs('80', 'kg');
    expect(stored).toBeCloseTo(176.37, 1);
    expect(weightFromStoredLbs(stored, 'kg')).toBeCloseTo(80, 2);
  });

  it('stores lb input as-is and returns the same lb display value', () => {
    const stored = weightToStoredLbs('180', 'lbs');
    expect(stored).toBe(180);
    expect(weightFromStoredLbs(stored, 'lbs')).toBe(180);
  });

  it('weightFromStoredLbs returns empty string for null / non-finite', () => {
    expect(weightFromStoredLbs(undefined, 'lbs')).toBe('');
    expect(weightFromStoredLbs(NaN, 'lbs')).toBe('');
  });

  it('weightToStoredLbs returns undefined for unparseable input', () => {
    expect(weightToStoredLbs('', 'lbs')).toBeUndefined();
  });
});

describe('round', () => {
  it('rounds to a given decimal precision', () => {
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(1.236, 2)).toBe(1.24);
    expect(round(1.5, 0)).toBe(2);
    expect(round(0)).toBe(0);
  });
});

describe('makeHealthEntry — weigh-in fields', () => {
  it('fills defaults and preserves provided fields', () => {
    const entry = makeHealthEntry({
      date: iso('2026-05-10'),
      weightLbs: 180,
      wellness: 5,
      symptoms: ['nausea'],
      notes: 'felt fine',
    });
    expect(entry.id).toMatch(/.+/);
    expect(entry.date).toBe('2026-05-10');
    expect(entry.weightLbs).toBe(180);
    expect(entry.wellness).toBe(5);
    expect(entry.symptoms).toEqual(['nausea']);
    expect(entry.notes).toBe('felt fine');
    expect(entry.amountMg).toBeUndefined();
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps a caller-provided id', () => {
    const entry = makeHealthEntry({ id: 'fixed-id', date: iso('2026-05-10') });
    expect(entry.id).toBe('fixed-id');
  });

  it('defaults symptoms to []', () => {
    const entry = makeHealthEntry({ date: iso('2026-05-10') });
    expect(entry.symptoms).toEqual([]);
  });

  it('parses createdAt / updatedAt overrides', () => {
    const entry = makeHealthEntry({
      date: iso('2026-05-10'),
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-02T00:00:00Z',
    });
    expect(entry.createdAt).toBe('2026-04-01T00:00:00.000Z');
    expect(entry.updatedAt).toBe('2026-04-02T00:00:00.000Z');
  });
});

describe('makeHealthEntry — dose fields', () => {
  it('normalizes medication aliases and trims site', () => {
    const entry = makeHealthEntry({
      date: iso('2026-05-10'),
      amountMg: 5,
      medication: 'Ozempic',
      site: '  belly  ',
    });
    expect(entry.medication).toBe('Semaglutide (Ozempic / Wegovy)');
    expect(entry.site).toBe('belly');
    expect(entry.amountMg).toBe(5);
  });

  it('parses planned status from a string', () => {
    const entry = makeHealthEntry({ date: iso('2026-05-10'), amountMg: 5, planned: 'planned' });
    expect(entry.planned).toBe(true);
  });

  it('leaves planned undefined when unparseable', () => {
    const entry = makeHealthEntry({ date: iso('2026-05-10'), amountMg: 5, planned: 'maybe' });
    expect(entry.planned).toBeUndefined();
  });

  it('parses confirmedAt to an ISO timestamp', () => {
    const entry = makeHealthEntry({
      date: iso('2026-05-10'),
      amountMg: 5,
      confirmedAt: '2026-05-10T08:00:00Z',
    });
    expect(entry.confirmedAt).toBe('2026-05-10T08:00:00.000Z');
  });

  it('defaults medication to empty string when unrecognized', () => {
    const entry = makeHealthEntry({ date: iso('2026-05-10'), amountMg: 5, medication: 'Aspirin' });
    expect(entry.medication).toBe('');
  });

  it('leaves dose fields unset for a weigh-in-only row', () => {
    const entry = makeHealthEntry({ date: iso('2026-05-10'), weightLbs: 180 });
    expect(entry.amountMg).toBeUndefined();
    expect(entry.medication).toBeUndefined();
    expect(entry.site).toBeUndefined();
  });
});

describe('makePrescription', () => {
  it('populates parsed fields and applies sortOrder', () => {
    const p = makePrescription({
      type: 'Mounjaro',
      compoundDate: '2026-05-01',
      refillDate: '2026-06-01',
      bud: '2026-12-01',
      lotNumber: ' LOT-1 ',
      concentrationMgMl: '10 mg',
      vialMl: '3 ml',
      prescribedDoseMg: '5',
      dosesLeft: '4',
      costUsd: '$199.99',
      pharmacy: 'Compound Co',
      additive: 'BAC water',
      status: 'active',
      sortOrder: '2',
    });
    expect(p.type).toBe('Tirzepatide (Mounjaro / Zepbound)');
    expect(p.compoundDate).toBe('2026-05-01');
    expect(p.refillDate).toBe('2026-06-01');
    expect(p.bud).toBe('2026-12-01');
    expect(p.lotNumber).toBe('LOT-1');
    expect(p.concentrationMgMl).toBe(10);
    expect(p.vialMl).toBe(3);
    expect(p.prescribedDoseMg).toBe(5);
    expect(p.dosesLeft).toBe(4);
    expect(p.costUsd).toBe(199.99);
    expect(p.pharmacy).toBe('Compound Co');
    expect(p.additive).toBe('BAC water');
    expect(p.status).toBe('active');
    expect(p.sortOrder).toBe(2);
    expect(p.id).toMatch(/.+/);
    expect(p.createdAt).toMatch(/T/);
    expect(p.updatedAt).toMatch(/T/);
  });

  it('drops an invalid status value', () => {
    expect(makePrescription({ status: 'not-a-status' }).status).toBeUndefined();
  });

  it.each(['warning', 'active', 'neutral'])('keeps status %s', (status) => {
    expect(makePrescription({ status }).status).toBe(status);
  });

  it('drops type when normalization fails', () => {
    expect(makePrescription({ type: 'Aspirin' }).type).toBeUndefined();
  });

  it('handles minimal/empty input without throwing', () => {
    const p = makePrescription({});
    expect(p.id).toMatch(/.+/);
    expect(p.type).toBeUndefined();
    expect(p.compoundDate).toBeUndefined();
    expect(p.lotNumber).toBeUndefined();
  });
});

describe('mergeWarnings', () => {
  it('deduplicates and flattens warning groups', () => {
    expect(mergeWarnings(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergeWarnings([], [])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYMPTOM_COLORS,
  DEFAULT_SYMPTOM_OPTIONS,
  symptomColor,
  symptomInitial,
} from './symptoms';

describe('DEFAULT_SYMPTOM_COLORS / DEFAULT_SYMPTOM_OPTIONS', () => {
  it('exposes the documented set of symptoms', () => {
    expect(DEFAULT_SYMPTOM_OPTIONS).toEqual([
      'Nausea',
      'Diarrhea',
      'Vomiting',
      'Constipation',
      'Abdominal pain',
      'Headache',
      'Anhedonia',
    ]);
  });

  it('every option has a matching color entry', () => {
    for (const option of DEFAULT_SYMPTOM_OPTIONS) {
      expect(DEFAULT_SYMPTOM_COLORS[option]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('options is derived from the keys of the colors map', () => {
    expect(DEFAULT_SYMPTOM_OPTIONS).toEqual(Object.keys(DEFAULT_SYMPTOM_COLORS));
  });
});

describe('symptomColor', () => {
  it('returns the matching color for a known symptom', () => {
    expect(symptomColor('Nausea', DEFAULT_SYMPTOM_COLORS)).toBe('#e7bb72');
    expect(symptomColor('Headache', DEFAULT_SYMPTOM_COLORS)).toBe('#ef9aa2');
  });

  it('falls back to the documented grey when the symptom is unknown', () => {
    expect(symptomColor('Unknown', DEFAULT_SYMPTOM_COLORS)).toBe('#c8ccd4');
    expect(symptomColor('', DEFAULT_SYMPTOM_COLORS)).toBe('#c8ccd4');
  });

  it('reads from the passed-in palette, not the default one', () => {
    const custom = { Fatigue: '#123456' };
    expect(symptomColor('Fatigue', custom)).toBe('#123456');
    // Nausea is in the default palette but not the custom one — falls back.
    expect(symptomColor('Nausea', custom)).toBe('#c8ccd4');
  });
});

describe('symptomInitial', () => {
  it.each([
    ['Nausea', 'N'],
    ['diarrhea', 'D'],
    ['Abdominal pain', 'A'],
    ['  vomiting', 'V'],
  ])('symptomInitial(%j) === %s', (input, expected) => {
    expect(symptomInitial(input)).toBe(expected);
  });

  it('returns "?" for empty / whitespace-only strings', () => {
    expect(symptomInitial('')).toBe('?');
    expect(symptomInitial('   ')).toBe('?');
    expect(symptomInitial('\t\n')).toBe('?');
  });

  it.each([
    ['🔥 fire', '🔥'],
    ['😀', '😀'],
    ['  🤕 headache', '🤕'],
    ['💊', '💊'],
  ])('preserves emoji as the first glyph: %j → %s', (input, expected) => {
    expect(symptomInitial(input)).toBe(expected);
  });
});

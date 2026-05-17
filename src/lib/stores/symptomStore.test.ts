import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  DEFAULT_SYMPTOM_COLORS,
  DEFAULT_SYMPTOM_OPTIONS,
  symptomColor,
  symptomColors,
  symptomInitial,
  symptomOptions,
} from '$lib/stores/symptomStore';

describe('symptomStore — re-exports', () => {
  it('re-exports the same constants from utils/symptoms', () => {
    expect(DEFAULT_SYMPTOM_OPTIONS).toContain('Nausea');
    expect(DEFAULT_SYMPTOM_COLORS['Nausea']).toBeTypeOf('string');
  });

  it('re-exports symptomColor with the fallback behavior', () => {
    expect(symptomColor('Nausea', DEFAULT_SYMPTOM_COLORS)).toBe(DEFAULT_SYMPTOM_COLORS['Nausea']);
    expect(symptomColor('Unknown', {})).toBe('#c8ccd4');
  });

  it('re-exports symptomInitial', () => {
    expect(symptomInitial('nausea')).toBe('N');
    expect(symptomInitial('')).toBe('?');
    expect(symptomInitial('  abdominal pain ')).toBe('A');
  });
});

describe('symptomStore — symptomOptions writable', () => {
  it('initializes to a copy (not the same reference) of DEFAULT_SYMPTOM_OPTIONS', () => {
    const initial = get(symptomOptions);
    expect(initial).toEqual(DEFAULT_SYMPTOM_OPTIONS);
    expect(initial).not.toBe(DEFAULT_SYMPTOM_OPTIONS);
  });

  it('can be set to a new list and read back', () => {
    symptomOptions.set(['Nausea', 'Fatigue']);
    expect(get(symptomOptions)).toEqual(['Nausea', 'Fatigue']);
    // Restore so other tests aren't surprised by this module-level singleton.
    symptomOptions.set([...DEFAULT_SYMPTOM_OPTIONS]);
  });
});

describe('symptomStore — symptomColors writable', () => {
  it('initializes to a copy of DEFAULT_SYMPTOM_COLORS', () => {
    const initial = get(symptomColors);
    expect(initial).toEqual(DEFAULT_SYMPTOM_COLORS);
    expect(initial).not.toBe(DEFAULT_SYMPTOM_COLORS);
  });

  it('can be updated to override a color', () => {
    symptomColors.update((m) => ({ ...m, Nausea: '#000000' }));
    expect(get(symptomColors).Nausea).toBe('#000000');
    symptomColors.set({ ...DEFAULT_SYMPTOM_COLORS });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import '../../test/dexie-setup';
import { clearAllData, getProfile } from '$lib/domain/health-data-storage';
import {
  DEFAULT_SYMPTOM_COLORS,
  DEFAULT_SYMPTOM_OPTIONS,
  addSymptomOption,
  registerSymptoms,
  removeSymptomOption,
  setSymptomColor,
  symptomColor,
  symptomColors,
  symptomInitial,
  symptomOptions,
} from '$lib/stores/symptomStore';

// The store is a module singleton; rehydrating it from a freshly-cleared DB
// in beforeEach would require ripping out the liveQuery subscriber, which is
// the point of the design. The mutation helpers update the local writable
// stores synchronously, so each test seeds via those and the assertions still
// see the value immediately. afterEach re-seeds the defaults.
async function resetStoresToDefaults() {
  // Drop any persisted profile so the next test starts from a clean slate.
  await clearAllData();
  // Reset the in-memory store via the same mutation helpers consumers use.
  const current = get(symptomOptions);
  for (const symptom of current) {
    if (!DEFAULT_SYMPTOM_OPTIONS.includes(symptom)) await removeSymptomOption(symptom);
  }
  // Re-add anything the defaults expect but the store has lost.
  for (const symptom of DEFAULT_SYMPTOM_OPTIONS) {
    if (!get(symptomOptions).includes(symptom)) await addSymptomOption(symptom, DEFAULT_SYMPTOM_COLORS[symptom]);
  }
  // After re-adding the user-added customizations are scrubbed; clear once
  // more so the profile row doesn't carry them into the next test.
  await clearAllData();
}

beforeEach(async () => {
  await resetStoresToDefaults();
});

afterEach(async () => {
  await clearAllData();
});

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

describe('symptomStore — addSymptomOption', () => {
  it('adds a new symptom with a generated color and persists to the profile', async () => {
    await addSymptomOption('Fatigue');
    expect(get(symptomOptions)).toContain('Fatigue');
    expect(get(symptomColors).Fatigue).toMatch(/^#[0-9a-f]{6}$/);

    const profile = await getProfile();
    expect(profile?.symptomOptions).toContain('Fatigue');
    expect(profile?.symptomColors?.Fatigue).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('accepts an explicit color and persists it', async () => {
    await addSymptomOption('Insomnia', '#123456');
    expect(get(symptomColors).Insomnia).toBe('#123456');
  });

  it('is a no-op for an already-known symptom', async () => {
    const before = get(symptomOptions).length;
    await addSymptomOption('Nausea');
    expect(get(symptomOptions).length).toBe(before);
  });

  it('skips empty / whitespace-only input', async () => {
    const before = get(symptomOptions).length;
    await addSymptomOption('   ');
    expect(get(symptomOptions).length).toBe(before);
  });
});

describe('symptomStore — removeSymptomOption', () => {
  it('drops the symptom and its color, persisting both', async () => {
    await addSymptomOption('Fatigue', '#abcdef');
    await removeSymptomOption('Fatigue');
    expect(get(symptomOptions)).not.toContain('Fatigue');
    expect(get(symptomColors).Fatigue).toBeUndefined();

    const profile = await getProfile();
    expect(profile?.symptomOptions).not.toContain('Fatigue');
    expect(profile?.symptomColors?.Fatigue).toBeUndefined();
  });
});

describe('symptomStore — setSymptomColor', () => {
  it('updates an existing symptom’s color and persists it', async () => {
    await setSymptomColor('Nausea', '#ff00ff');
    expect(get(symptomColors).Nausea).toBe('#ff00ff');
    const profile = await getProfile();
    expect(profile?.symptomColors?.Nausea).toBe('#ff00ff');
  });

  it('is a no-op for a symptom that isn’t in the options list', async () => {
    const before = get(symptomColors);
    await setSymptomColor('NeverHeardOfThis', '#ff00ff');
    expect(get(symptomColors)).toEqual(before);
  });
});

describe('symptomStore — registerSymptoms', () => {
  it('adds new symptoms with generated colors and persists everything in one write', async () => {
    await registerSymptoms(['Fatigue', 'Brain fog']);
    const opts = get(symptomOptions);
    const colors = get(symptomColors);
    expect(opts).toContain('Fatigue');
    expect(opts).toContain('Brain fog');
    expect(colors['Fatigue']).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors['Brain fog']).toMatch(/^#[0-9a-f]{6}$/);

    const profile = await getProfile();
    expect(profile?.symptomOptions).toEqual(expect.arrayContaining(['Fatigue', 'Brain fog']));
  });

  it('skips symptoms already present, leaving their existing color intact', async () => {
    const originalNauseaColor = get(symptomColors).Nausea;
    await registerSymptoms(['Nausea', 'Fatigue']);
    expect(get(symptomColors).Nausea).toBe(originalNauseaColor);
    expect(get(symptomOptions).filter((s) => s === 'Nausea')).toHaveLength(1);
  });

  it('ignores empty / whitespace-only entries', async () => {
    const before = get(symptomOptions).length;
    await registerSymptoms(['', '   ', '\t']);
    expect(get(symptomOptions).length).toBe(before);
  });
});

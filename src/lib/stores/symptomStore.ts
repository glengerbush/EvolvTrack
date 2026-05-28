import { browser } from '$app/environment';
import { liveQuery } from 'dexie';
import { get, writable, type Readable } from 'svelte/store';
import { db } from '$lib/db/schema';
import { saveProfile } from '$lib/domain/repo';
import type { ProfileSettings } from '$lib/domain/types';
import {
  DEFAULT_SYMPTOM_COLORS,
  DEFAULT_SYMPTOM_OPTIONS,
  generateSymptomColor,
  symptomColor,
  symptomInitial,
} from '$lib/utils/symptoms';

export {
  DEFAULT_SYMPTOM_COLORS,
  DEFAULT_SYMPTOM_OPTIONS,
  generateSymptomColor,
  symptomColor,
  symptomInitial,
};

const _options = writable<string[]>([...DEFAULT_SYMPTOM_OPTIONS]);
const _colors = writable<Record<string, string>>({ ...DEFAULT_SYMPTOM_COLORS });

/**
 * Apply a profile's symptom fields to the in-memory stores. Exported so
 * callers that just wrote the profile in a transaction can update consumers
 * synchronously, without waiting for the liveQuery subscriber below to
 * re-fire. Also the single source of truth for the "defaults + overrides"
 * shape, used by both the liveQuery hydrator and the importer.
 */
export function hydrateSymptomStoresFromProfile(profile: ProfileSettings | undefined): void {
  _options.set(
    profile?.symptomOptions ? [...profile.symptomOptions] : [...DEFAULT_SYMPTOM_OPTIONS],
  );
  _colors.set({
    ...DEFAULT_SYMPTOM_COLORS,
    ...(profile?.symptomColors ?? {}),
  });
}

// Hydrate from the profile in the browser. `liveQuery` re-fires whenever
// `db.profile` changes — initial load, local edits via `saveProfile`, and
// remote-pull merges all go through here, so the dropdown stays in sync
// across tabs and across devices on the same account.
if (browser) {
  liveQuery(() => db.profile.get('profile')).subscribe({
    next: hydrateSymptomStoresFromProfile,
    error: (e) => console.error('symptomStore liveQuery error:', e),
  });
}

/** Read-only view of the current symptom list (defaults overridden by profile). */
export const symptomOptions: Readable<string[]> = { subscribe: _options.subscribe };
/** Read-only view of the symptom→color map (defaults merged with profile overrides). */
export const symptomColors: Readable<Record<string, string>> = { subscribe: _colors.subscribe };

/**
 * Add a single symptom. No-op if the trimmed string is empty or already
 * present. Generates a color if none is supplied. Updates the local store
 * synchronously and persists to the profile (which then syncs to the cloud
 * via the outbox).
 */
export async function addSymptomOption(symptom: string, color?: string): Promise<void> {
  const trimmed = symptom.trim();
  if (!trimmed) return;
  const currentOptions = get(_options);
  if (currentOptions.includes(trimmed)) return;
  const currentColors = get(_colors);
  const nextOptions = [...currentOptions, trimmed];
  const nextColors = {
    ...currentColors,
    [trimmed]: color ?? currentColors[trimmed] ?? generateSymptomColor(),
  };
  _options.set(nextOptions);
  _colors.set(nextColors);
  await saveProfile({ symptomOptions: nextOptions, symptomColors: nextColors });
}

/** Drop a symptom from the list. The color entry goes with it. */
export async function removeSymptomOption(symptom: string): Promise<void> {
  const nextOptions = get(_options).filter((s) => s !== symptom);
  const { [symptom]: _removed, ...nextColors } = get(_colors);
  _options.set(nextOptions);
  _colors.set(nextColors);
  await saveProfile({ symptomOptions: nextOptions, symptomColors: nextColors });
}

/** Change the color of an existing symptom. No-op if the symptom is unknown. */
export async function setSymptomColor(symptom: string, color: string): Promise<void> {
  if (!get(_options).includes(symptom)) return;
  const nextColors = { ...get(_colors), [symptom]: color };
  _colors.set(nextColors);
  await saveProfile({ symptomColors: nextColors });
}

/**
 * Bulk-register any symptoms not already known, each with a generated color.
 * Used by the importer so rows whose symptoms aren't in the built-in palette
 * still show up in the dropdown. Empty / whitespace-only entries are
 * skipped. Single profile write regardless of how many additions there are.
 */
export async function registerSymptoms(symptoms: Iterable<string>): Promise<void> {
  const existing = new Set(get(_options));
  const additions: string[] = [];
  for (const raw of symptoms) {
    const symptom = raw.trim();
    if (!symptom || existing.has(symptom)) continue;
    existing.add(symptom);
    additions.push(symptom);
  }
  if (additions.length === 0) return;

  const nextOptions = [...get(_options), ...additions];
  const nextColors = { ...get(_colors) };
  for (const symptom of additions) {
    if (!nextColors[symptom]) nextColors[symptom] = generateSymptomColor();
  }
  _options.set(nextOptions);
  _colors.set(nextColors);
  await saveProfile({ symptomOptions: nextOptions, symptomColors: nextColors });
}

import { browser } from '$app/environment';
import { get, writable, type Readable } from 'svelte/store';
import { observeProfile, saveProfile } from '$lib/domain/health-data-storage';

export const DEFAULT_SHOT_LOCATION_OPTIONS = [
  'Abdomen (Left)',
  'Abdomen (Right)',
  'Thigh (Left)',
  'Thigh (Right)',
];

const _options = writable<string[]>([...DEFAULT_SHOT_LOCATION_OPTIONS]);

// See symptomStore.ts for the rationale — keep this list in sync with the
// profile and with other tabs/devices through Health Data Storage observation.
if (browser) {
  observeProfile(
    (profile) => {
      _options.set(
        profile?.shotLocationOptions
          ? [...profile.shotLocationOptions]
          : [...DEFAULT_SHOT_LOCATION_OPTIONS],
      );
    },
    (error) => console.error('shotLocationStore profile observation error:', error),
  );
}

export const shotLocationOptions: Readable<string[]> = { subscribe: _options.subscribe };

export async function addShotLocationOption(location: string): Promise<void> {
  const trimmed = location.trim();
  if (!trimmed) return;
  const current = get(_options);
  if (current.includes(trimmed)) return;
  const next = [...current, trimmed];
  _options.set(next);
  await saveProfile({ shotLocationOptions: next });
}

export async function removeShotLocationOption(location: string): Promise<void> {
  const next = get(_options).filter((item) => item !== location);
  _options.set(next);
  await saveProfile({ shotLocationOptions: next });
}

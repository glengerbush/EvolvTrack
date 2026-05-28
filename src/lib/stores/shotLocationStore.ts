import { browser } from '$app/environment';
import { liveQuery } from 'dexie';
import { get, writable, type Readable } from 'svelte/store';
import { db } from '$lib/db/schema';
import { saveProfile } from '$lib/domain/repo';

export const DEFAULT_SHOT_LOCATION_OPTIONS = [
  'Abdomen (Left)',
  'Abdomen (Right)',
  'Thigh (Left)',
  'Thigh (Right)',
];

const _options = writable<string[]>([...DEFAULT_SHOT_LOCATION_OPTIONS]);

// See symptomStore.ts for the rationale — keep this list in sync with the
// profile and with other tabs/devices via the same liveQuery pattern.
if (browser) {
  liveQuery(() => db.profile.get('profile')).subscribe({
    next: (profile) => {
      _options.set(
        profile?.shotLocationOptions
          ? [...profile.shotLocationOptions]
          : [...DEFAULT_SHOT_LOCATION_OPTIONS],
      );
    },
    error: (e) => console.error('shotLocationStore liveQuery error:', e),
  });
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

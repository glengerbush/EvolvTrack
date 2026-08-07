// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileSettings } from '$lib/domain/types';

// Source uses `typeof window === 'undefined'` to gate persistence, so we run
// under happy-dom (window exists) and rely on `src/test/setup.ts`'s in-memory
// `localStorage` shim.

const STORAGE_KEY = 'evolvtrack-theme';

let profileResult: ProfileSettings | undefined;
const saveProfile = vi.fn(async (_partial: unknown) => {});

vi.mock('$lib/domain/health-data-storage', () => ({
  getProfile: async () => profileResult,
  saveProfile: (partial: unknown) => saveProfile(partial),
}));

beforeEach(() => {
  localStorage.clear();
  profileResult = undefined;
  saveProfile.mockClear();
  vi.resetModules();
});

async function load() {
  const mod = await import('$lib/stores/themeStore');
  // Let the getProfile().then(...) microtask flush.
  await Promise.resolve();
  await Promise.resolve();
  return mod;
}

describe('themeStore — getInitialTheme', () => {
  it('defaults to "default" when nothing is stored and no profile theme exists', async () => {
    const { activeTheme } = await load();
    const { get } = await import('svelte/store');
    expect(get(activeTheme)).toBe('default');
  });

  it('reads "colorblind" from localStorage when present', async () => {
    localStorage.setItem(STORAGE_KEY, 'colorblind');
    const { activeTheme } = await load();
    const { get } = await import('svelte/store');
    expect(get(activeTheme)).toBe('colorblind');
  });

  it('falls back to "default" for an unrecognized value', async () => {
    localStorage.setItem(STORAGE_KEY, 'mauve');
    const { activeTheme } = await load();
    const { get } = await import('svelte/store');
    expect(get(activeTheme)).toBe('default');
  });

  it('lets the profile override the stored value when it loads', async () => {
    localStorage.setItem(STORAGE_KEY, 'default');
    profileResult = {
      id: 'profile',
      passphraseEnabled: false,
      colorTheme: 'greyscale',
      createdAt: 't',
      updatedAt: 't',
    } as ProfileSettings;
    const { activeTheme } = await load();
    const { get } = await import('svelte/store');
    expect(get(activeTheme)).toBe('greyscale');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('greyscale');
  });

  it('ignores a non-theme value from the profile', async () => {
    profileResult = {
      id: 'profile',
      passphraseEnabled: false,
      colorTheme: 'rainbow' as unknown as 'default',
      createdAt: 't',
      updatedAt: 't',
    } as ProfileSettings;
    const { activeTheme } = await load();
    const { get } = await import('svelte/store');
    expect(get(activeTheme)).toBe('default');
  });
});

describe('themeStore — activeTheme.set', () => {
  it('updates the store, persists to localStorage, and saves to profile', async () => {
    const { activeTheme } = await load();
    const { get } = await import('svelte/store');
    activeTheme.set('colorblind');
    expect(get(activeTheme)).toBe('colorblind');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('colorblind');
    expect(saveProfile).toHaveBeenCalledWith({ colorTheme: 'colorblind' });
  });
});

describe('themeStore — activeTabThemes', () => {
  it('returns the TabThemes record for the current theme', async () => {
    const { activeTheme, activeTabThemes } = await load();
    const { get } = await import('svelte/store');
    const initial = get(activeTabThemes);
    expect(initial).toHaveProperty('health');
    expect(initial).toHaveProperty('medication');
    activeTheme.set('greyscale');
    const after = get(activeTabThemes);
    // Should swap to a different ThemeName's TabThemes — at minimum the
    // reference changes when the source theme changes.
    expect(after).not.toBe(initial);
  });
});

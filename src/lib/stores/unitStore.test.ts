// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileSettings } from '$lib/domain/types';

// Source uses `typeof window === 'undefined'` to gate persistence, so we run
// under happy-dom (window exists) and rely on `src/test/setup.ts`'s in-memory
// `localStorage` shim.

const STORAGE_KEY = 'evolvtrack-weight-unit';

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
  const mod = await import('$lib/stores/unitStore');
  await Promise.resolve();
  await Promise.resolve();
  return mod;
}

describe('unitStore — initial value', () => {
  it('defaults to "lbs"', async () => {
    const { weightUnit } = await load();
    const { get } = await import('svelte/store');
    expect(get(weightUnit)).toBe('lbs');
  });

  it('reads "kg" from localStorage when set', async () => {
    localStorage.setItem(STORAGE_KEY, 'kg');
    const { weightUnit } = await load();
    const { get } = await import('svelte/store');
    expect(get(weightUnit)).toBe('kg');
  });

  it('falls back to "lbs" for any other localStorage value', async () => {
    localStorage.setItem(STORAGE_KEY, 'stone');
    const { weightUnit } = await load();
    const { get } = await import('svelte/store');
    expect(get(weightUnit)).toBe('lbs');
  });

  it('lets the profile override the stored value when it loads', async () => {
    profileResult = {
      id: 'profile',
      passphraseEnabled: false,
      weightUnit: 'kg',
      createdAt: 't',
      updatedAt: 't',
    } as ProfileSettings;
    const { weightUnit } = await load();
    const { get } = await import('svelte/store');
    expect(get(weightUnit)).toBe('kg');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('kg');
  });

  it('ignores an invalid weightUnit from the profile', async () => {
    profileResult = {
      id: 'profile',
      passphraseEnabled: false,
      weightUnit: 'stone' as unknown as 'lbs',
      createdAt: 't',
      updatedAt: 't',
    } as ProfileSettings;
    const { weightUnit } = await load();
    const { get } = await import('svelte/store');
    expect(get(weightUnit)).toBe('lbs');
  });
});

describe('unitStore — weightUnit.set', () => {
  it('persists to localStorage and saves to profile', async () => {
    const { weightUnit } = await load();
    const { get } = await import('svelte/store');
    weightUnit.set('kg');
    expect(get(weightUnit)).toBe('kg');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('kg');
    expect(saveProfile).toHaveBeenCalledWith({ weightUnit: 'kg' });
  });
});

describe('unitStore — displayWeight', () => {
  it('returns empty string for an empty input', async () => {
    const { displayWeight } = await load();
    expect(displayWeight('', 'lbs')).toBe('');
    expect(displayWeight('', 'kg')).toBe('');
  });

  it('returns the original string when the value is not finite', async () => {
    const { displayWeight } = await load();
    expect(displayWeight('NaN', 'lbs')).toBe('NaN');
    expect(displayWeight('hello', 'kg')).toBe('hello');
  });

  it('formats integer lbs without a decimal', async () => {
    const { displayWeight } = await load();
    expect(displayWeight('180', 'lbs')).toBe('180');
  });

  it('formats fractional lbs to a single decimal place', async () => {
    const { displayWeight } = await load();
    expect(displayWeight('180.456', 'lbs')).toBe('180.5');
  });

  it('converts lbs → kg with one decimal', async () => {
    const { displayWeight } = await load();
    // 180 lbs × 0.453592 = 81.6 kg (1dp)
    expect(displayWeight('180', 'kg')).toBe('81.6');
  });
});

describe('unitStore — toStoredLbs', () => {
  it('returns empty string for empty input', async () => {
    const { toStoredLbs } = await load();
    expect(toStoredLbs('', 'lbs')).toBe('');
    expect(toStoredLbs('', 'kg')).toBe('');
  });

  it('returns the input when the value is not finite', async () => {
    const { toStoredLbs } = await load();
    expect(toStoredLbs('abc', 'lbs')).toBe('abc');
  });

  it('passes lbs through unchanged', async () => {
    const { toStoredLbs } = await load();
    expect(toStoredLbs('180', 'lbs')).toBe('180');
    expect(toStoredLbs('180.5', 'lbs')).toBe('180.5');
  });

  it('converts kg → lbs', async () => {
    const { toStoredLbs } = await load();
    // 82 kg / 0.453592 ≈ 180.78
    const out = parseFloat(toStoredLbs('82', 'kg'));
    expect(out).toBeCloseTo(180.78, 1);
  });

  it('round-trips a kg input through display → stored', async () => {
    const { displayWeight, toStoredLbs } = await load();
    const original = '180';
    const asKg = displayWeight(original, 'kg');
    const backToLbs = parseFloat(toStoredLbs(asKg, 'kg'));
    expect(backToLbs).toBeCloseTo(180, 0);
  });
});

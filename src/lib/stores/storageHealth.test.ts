// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import { get } from 'svelte/store';

// The store reads `browser` to decide whether to touch localStorage.
vi.mock('$app/environment', () => ({ browser: true }));

import {
  dismissStorageWarning,
  storageBannerKind,
  storageWarningDismissed,
} from './storageHealth';

afterEach(() => {
  storageWarningDismissed.set(false);
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

describe('storageBannerKind', () => {
  it('shows the severe banner when storage is unavailable', () => {
    expect(storageBannerKind('unavailable', false)).toBe('unavailable');
  });

  it('shows the caution banner when storage is ephemeral', () => {
    expect(storageBannerKind('ephemeral', false)).toBe('ephemeral');
  });

  it('shows nothing while storage is healthy or not yet checked', () => {
    expect(storageBannerKind('ok', false)).toBeNull();
    expect(storageBannerKind('unknown', false)).toBeNull();
  });

  it('a dismissal hides every tier', () => {
    expect(storageBannerKind('unavailable', true)).toBeNull();
    expect(storageBannerKind('ephemeral', true)).toBeNull();
  });
});

describe('dismissStorageWarning', () => {
  it('sets the store and persists the flag so it survives a reload', () => {
    expect(get(storageWarningDismissed)).toBe(false);
    dismissStorageWarning();
    expect(get(storageWarningDismissed)).toBe(true);
    expect(localStorage.getItem('evolvtrack:storageWarningDismissed')).toBe('1');
  });
});

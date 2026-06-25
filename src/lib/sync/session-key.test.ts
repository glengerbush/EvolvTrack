// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  clearSession,
  getSessionKey,
  hasSessionKey,
  rehydrateSession,
  sessionLocked,
  setSessionKey,
} from './session-key';
import { durableClear, durableGet, durableSet } from '$lib/db/durableKv';

const DEK_KEY = 'et.session.dek';
const LEGACY_KEY = 'et.session.key';

beforeEach(async () => {
  localStorage.clear();
  clearSession();
  await durableClear();
});

afterEach(async () => {
  localStorage.clear();
  clearSession();
  await durableClear();
});

describe('session key cache', () => {
  it('starts empty and locked', () => {
    expect(getSessionKey()).toBeNull();
    expect(hasSessionKey()).toBe(false);
    expect(get(sessionLocked)).toBe(true);
  });

  it('holds a key once set and flips the locked store', () => {
    setSessionKey('KEY_AAA');
    expect(getSessionKey()).toBe('KEY_AAA');
    expect(hasSessionKey()).toBe(true);
    expect(get(sessionLocked)).toBe(false);
  });

  it('clears back to empty and re-locks', () => {
    setSessionKey('KEY_AAA');
    clearSession();
    expect(getSessionKey()).toBeNull();
    expect(hasSessionKey()).toBe(false);
    expect(get(sessionLocked)).toBe(true);
  });

  it('overwrites a previously set key', () => {
    setSessionKey('first');
    setSessionKey('second');
    expect(getSessionKey()).toBe('second');
  });
});

describe('persistence', () => {
  // The DEK is persisted to IndexedDB (durableKv) rather than localStorage,
  // because iOS Home Screen PWAs discard localStorage on swipe-away. Writes are
  // fire-and-forget, so assertions poll with vi.waitFor.

  it('writes the DEK to the durable IndexedDB store', async () => {
    setSessionKey('KEY_AAA');
    await vi.waitFor(async () => {
      expect(await durableGet(DEK_KEY)).toBe('KEY_AAA');
    });
  });

  it('does NOT leave the DEK in localStorage', async () => {
    setSessionKey('KEY_AAA');
    await vi.waitFor(async () => {
      expect(await durableGet(DEK_KEY)).toBe('KEY_AAA');
    });
    expect(localStorage.getItem(DEK_KEY)).toBeNull();
  });

  it('clearSession wipes the persisted durable entry', async () => {
    setSessionKey('KEY_AAA');
    await vi.waitFor(async () => {
      expect(await durableGet(DEK_KEY)).toBe('KEY_AAA');
    });
    clearSession();
    await vi.waitFor(async () => {
      expect(await durableGet(DEK_KEY)).toBeNull();
    });
  });

  it('clearSession also wipes any legacy et.session.key localStorage entry', () => {
    // Older builds cached the passphrase-derived key under et.session.key in
    // localStorage. clearSession should evict it so a stale legacy value never
    // re-hydrates.
    localStorage.setItem(LEGACY_KEY, 'STALE');
    clearSession();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('setSessionKey wipes any legacy localStorage slots too', () => {
    localStorage.setItem(LEGACY_KEY, 'STALE');
    localStorage.setItem(DEK_KEY, 'OLD');
    setSessionKey('NEW_DEK');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(DEK_KEY)).toBeNull();
  });
});

describe('rehydrateSession', () => {
  it('resolves false and stays locked when nothing is persisted', async () => {
    expect(await rehydrateSession()).toBe(false);
    expect(hasSessionKey()).toBe(false);
    expect(get(sessionLocked)).toBe(true);
  });

  it('loads a key persisted in the durable store, unlocks, and exposes it', async () => {
    await durableSet(DEK_KEY, 'PERSISTED');
    expect(await rehydrateSession()).toBe(true);
    expect(getSessionKey()).toBe('PERSISTED');
    expect(get(sessionLocked)).toBe(false);
  });

  it('migrates a key from the old localStorage slot into the durable store', async () => {
    // Upgrade path: a desktop browser (or first launch after the upgrade) may
    // still hold the DEK in localStorage. Rehydrate should adopt it and copy it
    // into IndexedDB so the user isn't re-prompted for their passphrase.
    localStorage.setItem(DEK_KEY, 'LEGACY');
    expect(await rehydrateSession()).toBe(true);
    expect(getSessionKey()).toBe('LEGACY');
    await vi.waitFor(async () => {
      expect(await durableGet(DEK_KEY)).toBe('LEGACY');
    });
  });
});

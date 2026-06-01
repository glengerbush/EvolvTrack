// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  clearSession,
  getSessionKey,
  hasSessionKey,
  rehydrateSession,
  sessionLocked,
  setSessionKey,
} from './session-key';

beforeEach(() => {
  localStorage.clear();
  clearSession();
});

afterEach(() => {
  localStorage.clear();
  clearSession();
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
  it('always writes the DEK to localStorage', () => {
    setSessionKey('KEY_AAA');
    expect(localStorage.getItem('et.session.dek')).toBe('KEY_AAA');
  });

  it('clearSession wipes the persisted entry', () => {
    setSessionKey('KEY_AAA');
    clearSession();
    expect(localStorage.getItem('et.session.dek')).toBeNull();
  });

  it('clearSession also wipes any legacy et.session.key entry', () => {
    // Older builds cached the passphrase-derived key under et.session.key.
    // The current build caches the DEK under et.session.dek. clearSession
    // should evict both so a stale legacy value never re-hydrates.
    localStorage.setItem('et.session.key', 'STALE');
    clearSession();
    expect(localStorage.getItem('et.session.key')).toBeNull();
  });

  it('setSessionKey wipes any legacy et.session.key entry too', () => {
    localStorage.setItem('et.session.key', 'STALE');
    setSessionKey('NEW_DEK');
    expect(localStorage.getItem('et.session.key')).toBeNull();
  });
});

describe('rehydrateSession', () => {
  it('returns false and stays locked when nothing is persisted', () => {
    expect(rehydrateSession()).toBe(false);
    expect(hasSessionKey()).toBe(false);
    expect(get(sessionLocked)).toBe(true);
  });

  it('loads a persisted key, unlocks, and exposes it via getSessionKey', () => {
    localStorage.setItem('et.session.dek', 'PERSISTED');
    expect(rehydrateSession()).toBe(true);
    expect(getSessionKey()).toBe('PERSISTED');
    expect(get(sessionLocked)).toBe(false);
  });
});

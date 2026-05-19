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
  it('does not write to localStorage by default', () => {
    setSessionKey('KEY_AAA');
    expect(localStorage.getItem('et.session.key')).toBeNull();
  });

  it('writes to localStorage when persist:true', () => {
    setSessionKey('KEY_AAA', { persist: true });
    expect(localStorage.getItem('et.session.key')).toBe('KEY_AAA');
  });

  it('clearSession wipes the persisted entry', () => {
    setSessionKey('KEY_AAA', { persist: true });
    clearSession();
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
    localStorage.setItem('et.session.key', 'PERSISTED');
    expect(rehydrateSession()).toBe(true);
    expect(getSessionKey()).toBe('PERSISTED');
    expect(get(sessionLocked)).toBe(false);
  });
});

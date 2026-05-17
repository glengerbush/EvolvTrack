import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSessionPassphrase,
  getSessionPassphrase,
  hasSessionPassphrase,
  setSessionPassphrase,
} from './session-key';

afterEach(() => {
  clearSessionPassphrase();
});

describe('session passphrase cache', () => {
  it('starts empty', () => {
    expect(getSessionPassphrase()).toBeNull();
    expect(hasSessionPassphrase()).toBe(false);
  });

  it('holds a passphrase once set', () => {
    setSessionPassphrase('hunter2');
    expect(getSessionPassphrase()).toBe('hunter2');
    expect(hasSessionPassphrase()).toBe(true);
  });

  it('clears back to empty', () => {
    setSessionPassphrase('hunter2');
    clearSessionPassphrase();
    expect(getSessionPassphrase()).toBeNull();
    expect(hasSessionPassphrase()).toBe(false);
  });

  it('overwrites a previously set passphrase', () => {
    setSessionPassphrase('first');
    setSessionPassphrase('second');
    expect(getSessionPassphrase()).toBe('second');
  });
});

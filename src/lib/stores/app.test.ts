// @vitest-environment happy-dom
// Source reads `navigator.onLine` at module load and subscribes to the
// `online` / `offline` window events. happy-dom provides both natively.
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

const { passphraseUnlocked, offline } = await import('$lib/stores/app');

describe('app — passphraseUnlocked', () => {
  it('defaults to false', () => {
    expect(get(passphraseUnlocked)).toBe(false);
  });

  it('is a writable store that can be set true', () => {
    passphraseUnlocked.set(true);
    expect(get(passphraseUnlocked)).toBe(true);
    passphraseUnlocked.set(false);
    expect(get(passphraseUnlocked)).toBe(false);
  });
});

describe('app — offline', () => {
  it('initializes from navigator.onLine (we set onLine=true → offline=false)', () => {
    // The module read navigator.onLine at import time; we set onLine=true above.
    expect(get(offline)).toBe(false);
  });

  it('flips to true when the window emits an "offline" event', () => {
    window.dispatchEvent(new Event('offline'));
    expect(get(offline)).toBe(true);
  });

  it('flips back to false when the window emits an "online" event', () => {
    window.dispatchEvent(new Event('offline'));
    expect(get(offline)).toBe(true);
    window.dispatchEvent(new Event('online'));
    expect(get(offline)).toBe(false);
  });
});
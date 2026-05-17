// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Source uses `typeof window === 'undefined'` to gate persistence, so we run
// under happy-dom (window exists) and rely on `src/test/setup.ts`'s in-memory
// `localStorage` shim.

const KEY = 'evolvtrack-last-synced';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function load() {
  return import('$lib/stores/syncStore');
}

describe('syncStore — initial value', () => {
  it('starts null when localStorage is empty', async () => {
    const { lastSynced } = await load();
    const { get } = await import('svelte/store');
    expect(get(lastSynced)).toBeNull();
  });

  it('hydrates a valid ISO string into a Date', async () => {
    const iso = '2026-05-01T12:34:00.000Z';
    localStorage.setItem(KEY, iso);
    const { lastSynced } = await load();
    const { get } = await import('svelte/store');
    const v = get(lastSynced);
    expect(v).toBeInstanceOf(Date);
    expect((v as Date).toISOString()).toBe(iso);
  });

  it('returns null when the stored value is unparseable', async () => {
    localStorage.setItem(KEY, 'not-a-date');
    const { lastSynced } = await load();
    const { get } = await import('svelte/store');
    expect(get(lastSynced)).toBeNull();
  });
});

describe('syncStore — record()', () => {
  it('writes "now" to localStorage and the store', async () => {
    const { lastSynced } = await load();
    const { get } = await import('svelte/store');
    lastSynced.record();
    const v = get(lastSynced);
    expect(v).toBeInstanceOf(Date);
    const stored = localStorage.getItem(KEY);
    expect(stored).toBe((v as Date).toISOString());
  });

  it('updates monotonically across successive calls', async () => {
    const { lastSynced } = await load();
    const { get } = await import('svelte/store');
    lastSynced.record();
    const first = get(lastSynced) as Date;
    // Advance time so the second call produces a strictly later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    lastSynced.record();
    const second = get(lastSynced) as Date;
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });
});

describe('syncStore — formatSyncTime', () => {
  it('uses the "synced HH:MM" shape when the date is today', async () => {
    const { formatSyncTime } = await load();
    const now = new Date();
    const result = formatSyncTime(now);
    expect(result.startsWith('synced ')).toBe(true);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
    // Same-day branch should not include a month name.
    expect(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(result)).toBe(false);
  });

  it('includes a date when the input is a different day', async () => {
    const { formatSyncTime } = await load();
    const past = new Date();
    past.setDate(past.getDate() - 7);
    const result = formatSyncTime(past);
    expect(result.startsWith('synced ')).toBe(true);
    // Different-day branch includes both a date and a time.
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPullCursor, getPullCursor, hydratePullCursor, setPullCursor } from './pull-cursor';
import { durableClear, durableGet, durableSet } from '$lib/db/durableKv';

const CURSOR_KEY = 'evolvtrack-pull-cursor';

beforeEach(async () => {
  clearPullCursor();
  localStorage.clear();
  await durableClear();
});

afterEach(async () => {
  clearPullCursor();
  localStorage.clear();
  await durableClear();
});

describe('pull cursor', () => {
  it('starts null when nothing has been pulled', () => {
    expect(getPullCursor()).toBeNull();
  });

  it('round-trips a stored cursor value', () => {
    setPullCursor('2026-05-10T00:00:00.000Z');
    expect(getPullCursor()).toBe('2026-05-10T00:00:00.000Z');
  });

  it('clears back to null', () => {
    setPullCursor('2026-05-10T00:00:00.000Z');
    clearPullCursor();
    expect(getPullCursor()).toBeNull();
  });

  it('advances to the most recently set value', () => {
    setPullCursor('2026-05-10T00:00:00.000Z');
    setPullCursor('2026-05-11T00:00:00.000Z');
    expect(getPullCursor()).toBe('2026-05-11T00:00:00.000Z');
  });
});

describe('durability', () => {
  // The cursor persists to the durable IndexedDB store so it survives an iOS
  // PWA quit (localStorage doesn't), keeping it consistent with the local data.

  it('persists a set cursor to the durable store', async () => {
    setPullCursor('2026-05-12T00:00:00.000Z');
    await vi.waitFor(async () => {
      expect(await durableGet(CURSOR_KEY)).toBe('2026-05-12T00:00:00.000Z');
    });
  });

  it('hydrates the in-memory cursor from the durable store at boot', async () => {
    await durableSet(CURSOR_KEY, '2026-05-13T00:00:00.000Z');
    expect(getPullCursor()).toBeNull(); // not loaded yet
    await hydratePullCursor();
    expect(getPullCursor()).toBe('2026-05-13T00:00:00.000Z');
  });

  it('migrates a legacy localStorage cursor into the durable store', async () => {
    localStorage.setItem(CURSOR_KEY, '2026-05-14T00:00:00.000Z');
    await hydratePullCursor();
    expect(getPullCursor()).toBe('2026-05-14T00:00:00.000Z');
    expect(localStorage.getItem(CURSOR_KEY)).toBeNull();
    await vi.waitFor(async () => {
      expect(await durableGet(CURSOR_KEY)).toBe('2026-05-14T00:00:00.000Z');
    });
  });

  it('clearPullCursor wipes the durable entry too', async () => {
    setPullCursor('2026-05-15T00:00:00.000Z');
    await vi.waitFor(async () => {
      expect(await durableGet(CURSOR_KEY)).toBe('2026-05-15T00:00:00.000Z');
    });
    clearPullCursor();
    await vi.waitFor(async () => {
      expect(await durableGet(CURSOR_KEY)).toBeNull();
    });
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

/**
 * `fromLiveQuery` has two branches:
 *
 *   - When `$app/environment`.browser is false (SSR / Node tests), it returns
 *     a `readable(initial)` — no Dexie subscription at all.
 *   - When `browser` is true, it subscribes to `liveQuery(querier)` and writes
 *     each emission into the readable.
 *
 * We exercise both by `vi.doMock`-ing the modules and re-importing the module
 * under test. We avoid `vi.mock` (top-level hoisting) because we need to vary
 * the mock between tests in the same file.
 */

describe('fromLiveQuery — SSR / non-browser branch', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('$app/environment');
    vi.doUnmock('dexie');
  });

  it('returns a readable holding the initial value without subscribing to liveQuery', async () => {
    vi.doMock('$app/environment', () => ({ browser: false }));

    const liveQuerySpy = vi.fn();
    vi.doMock('dexie', () => ({ liveQuery: liveQuerySpy }));

    const { fromLiveQuery } = await import('$lib/db/liveQuery');
    const querier = vi.fn().mockResolvedValue('should-not-be-called');

    const store = fromLiveQuery(querier, 'initial');
    expect(get(store)).toBe('initial');

    // No subscription -> liveQuery is never invoked, querier never runs.
    expect(liveQuerySpy).not.toHaveBeenCalled();
    expect(querier).not.toHaveBeenCalled();
  });

  it('returns the initial value as-is even for complex shapes', async () => {
    vi.doMock('$app/environment', () => ({ browser: false }));
    vi.doMock('dexie', () => ({ liveQuery: vi.fn() }));

    const { fromLiveQuery } = await import('$lib/db/liveQuery');
    const initial = { items: [1, 2, 3] };
    const store = fromLiveQuery(async () => ({ items: [] }), initial);
    expect(get(store)).toBe(initial);
  });
});

describe('fromLiveQuery — browser branch', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('$app/environment');
    vi.doUnmock('dexie');
  });

  it('subscribes to liveQuery and pushes emissions into the readable', async () => {
    vi.doMock('$app/environment', () => ({ browser: true }));

    // Capture the subscriber callbacks so we can drive them manually.
    type Observer<T> = { next: (v: T) => void; error: (e: unknown) => void };
    let captured: Observer<number> | null = null;
    const unsubscribe = vi.fn();
    const liveQuerySpy = vi.fn((querier: () => Promise<number>) => ({
      subscribe(obs: Observer<number>) {
        captured = obs;
        // Touch the querier so we don't get an unused-arg lint complaint.
        void querier;
        return { unsubscribe };
      },
    }));
    vi.doMock('dexie', () => ({ liveQuery: liveQuerySpy }));

    const { fromLiveQuery } = await import('$lib/db/liveQuery');
    const store = fromLiveQuery<number>(async () => 1, 0);

    // Readable only starts its start-fn when something subscribes.
    const seen: number[] = [];
    const off = store.subscribe((v) => seen.push(v));

    expect(liveQuerySpy).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(seen).toEqual([0]); // initial value

    captured!.next(7);
    expect(get(store)).toBe(7);
    captured!.next(11);
    expect(get(store)).toBe(11);
    expect(seen).toEqual([0, 7, 11]);

    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('logs liveQuery errors via console.error and keeps the last value', async () => {
    vi.doMock('$app/environment', () => ({ browser: true }));

    type Observer<T> = { next: (v: T) => void; error: (e: unknown) => void };
    let captured: Observer<number> | null = null;
    const liveQuerySpy = vi.fn(() => ({
      subscribe(obs: Observer<number>) {
        captured = obs;
        return { unsubscribe: vi.fn() };
      },
    }));
    vi.doMock('dexie', () => ({ liveQuery: liveQuerySpy }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { fromLiveQuery } = await import('$lib/db/liveQuery');
      const store = fromLiveQuery<number>(async () => 0, -1);
      const off = store.subscribe(() => {});

      const boom = new Error('boom');
      captured!.error(boom);

      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toBe('liveQuery error:');
      expect(errSpy.mock.calls[0][1]).toBe(boom);
      // Last known value is still the initial since no next() arrived.
      expect(get(store)).toBe(-1);

      off();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('unsubscribes from liveQuery when the last subscriber leaves', async () => {
    vi.doMock('$app/environment', () => ({ browser: true }));

    const unsubscribe = vi.fn();
    const liveQuerySpy = vi.fn(() => ({
      subscribe() {
        return { unsubscribe };
      },
    }));
    vi.doMock('dexie', () => ({ liveQuery: liveQuerySpy }));

    const { fromLiveQuery } = await import('$lib/db/liveQuery');
    const store = fromLiveQuery<number>(async () => 0, 0);

    const off1 = store.subscribe(() => {});
    const off2 = store.subscribe(() => {});
    expect(unsubscribe).not.toHaveBeenCalled();
    off1();
    expect(unsubscribe).not.toHaveBeenCalled();
    off2();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

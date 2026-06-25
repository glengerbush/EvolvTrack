// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { durableClear, durableGet, durableRemove, durableSet } from './durableKv';

beforeEach(async () => {
  await durableClear();
});

afterEach(async () => {
  await durableClear();
});

describe('durableKv', () => {
  it('returns null for a key that was never written', async () => {
    expect(await durableGet('missing')).toBeNull();
  });

  it('round-trips a stored value', async () => {
    await durableSet('token', 'abc123');
    expect(await durableGet('token')).toBe('abc123');
  });

  it('overwrites an existing value', async () => {
    await durableSet('token', 'first');
    await durableSet('token', 'second');
    expect(await durableGet('token')).toBe('second');
  });

  it('removes a single key without touching others', async () => {
    await durableSet('a', '1');
    await durableSet('b', '2');
    await durableRemove('a');
    expect(await durableGet('a')).toBeNull();
    expect(await durableGet('b')).toBe('2');
  });

  it('clears every key', async () => {
    await durableSet('a', '1');
    await durableSet('b', '2');
    await durableClear();
    expect(await durableGet('a')).toBeNull();
    expect(await durableGet('b')).toBeNull();
  });
});

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  fromMock: vi.fn(),
  getUserMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => h.getUserMock(...args) },
    from: (...args: unknown[]) => h.fromMock(...args),
    rpc: (...args: unknown[]) => h.rpcMock(...args),
  },
}));

import {
  __resetDeviceIdForTests,
  abandonSyncTransition,
  advanceSyncTransitionPhase,
  getDeviceId,
  hydrateDeviceId,
  requireAuthenticatedUser,
  upsertRemoteSyncAccount,
} from './account-state';
import { durableClear, durableGet, durableSet } from '$lib/db/durableKv';

const DEVICE_ID_KEY = 'evolvtrack-device-id';

beforeEach(async () => {
  localStorage.clear();
  __resetDeviceIdForTests();
  await durableClear();
  h.upsertMock.mockReset();
  h.fromMock.mockReset();
  h.getUserMock.mockReset();
  h.rpcMock.mockReset();
  h.upsertMock.mockResolvedValue({ error: null });
  h.fromMock.mockImplementation(() => ({ upsert: h.upsertMock }));
  h.getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  h.rpcMock.mockResolvedValue({ data: null, error: null });
});

afterEach(async () => {
  localStorage.clear();
  __resetDeviceIdForTests();
  await durableClear();
});

describe('getDeviceId', () => {
  // The device id is the migration-ownership token. It is hydrated/persisted by
  // hydrateDeviceId (durable IndexedDB, not localStorage, so it survives an iOS
  // PWA quit). getDeviceId itself is a synchronous accessor over that cache.

  it('returns a non-empty id without leaking it to localStorage', () => {
    const id = getDeviceId();
    expect(id).toBeTruthy();
    // Never written to localStorage, where iOS would wipe it on swipe-away.
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBeNull();
  });

  it('returns the same id on subsequent calls (stable per device)', () => {
    const first = getDeviceId();
    const second = getDeviceId();
    expect(second).toBe(first);
  });

  it('does not persist a pre-hydrate minted id (hydrate owns persistence)', async () => {
    // A bare getDeviceId() before hydrate must not write to the durable store,
    // or it could clobber an id already stored there.
    getDeviceId();
    await Promise.resolve(); // flush any microtask a stray write would schedule
    expect(await durableGet(DEVICE_ID_KEY)).toBeNull();
  });
});

describe('hydrateDeviceId', () => {
  it('adopts a pre-existing id from the durable store', async () => {
    await durableSet(DEVICE_ID_KEY, 'preset-device-id');
    __resetDeviceIdForTests();
    expect(await hydrateDeviceId()).toBe('preset-device-id');
    expect(getDeviceId()).toBe('preset-device-id');
  });

  it('migrates a legacy localStorage id into the durable store', async () => {
    localStorage.setItem(DEVICE_ID_KEY, 'legacy-device-id');
    __resetDeviceIdForTests();
    expect(await hydrateDeviceId()).toBe('legacy-device-id');
    expect(getDeviceId()).toBe('legacy-device-id');
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBeNull();
    await vi.waitFor(async () => {
      expect(await durableGet(DEVICE_ID_KEY)).toBe('legacy-device-id');
    });
  });

  it('mints and persists a fresh id when nothing is stored', async () => {
    const id = await hydrateDeviceId();
    expect(id).toBeTruthy();
    expect(getDeviceId()).toBe(id);
    await vi.waitFor(async () => {
      expect(await durableGet(DEVICE_ID_KEY)).toBe(id);
    });
  });

  it('lets a stored id win over one minted before hydrate ran', async () => {
    // getDeviceId() can mint a temporary id if it's called before hydrate; a
    // real persisted id must still take precedence so identity stays continuous.
    await durableSet(DEVICE_ID_KEY, 'stored-id');
    const minted = getDeviceId();
    expect(minted).not.toBe('stored-id');
    expect(await hydrateDeviceId()).toBe('stored-id');
    expect(getDeviceId()).toBe('stored-id');
  });
});

describe('requireAuthenticatedUser', () => {
  it('returns the user when getUser resolves with one', async () => {
    const user = await requireAuthenticatedUser();
    expect(user).toEqual({ id: 'user-1' });
    expect(h.getUserMock).toHaveBeenCalledTimes(1);
  });

  it('throws when supabase returns an auth error', async () => {
    h.getUserMock.mockResolvedValueOnce({ data: { user: null }, error: new Error('boom') });
    await expect(requireAuthenticatedUser()).rejects.toThrow('boom');
  });

  it('throws a friendly message when there is no user and no error', async () => {
    h.getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(requireAuthenticatedUser()).rejects.toThrow(/sign in/i);
  });
});

describe('upsertRemoteSyncAccount', () => {
  it('sends the sync mode and user id, with nulls for missing migration fields', async () => {
    await upsertRemoteSyncAccount('plain');

    expect(h.fromMock).toHaveBeenCalledWith('sync_accounts');
    expect(h.upsertMock).toHaveBeenCalledTimes(1);
    const [row, options] = h.upsertMock.mock.calls[0];
    expect(row).toMatchObject({
      user_id: 'user-1',
      sync_mode: 'plain',
      e2ee_migration_id: null,
      e2ee_migration_direction: null,
      migration_owner_device_id: null,
      migration_started_at: null,
      migration_updated_at: null,
      migration_completed_at: null,
      plaintext_high_water_mark: null,
    });
    expect(typeof (row as Record<string, unknown>).updated_at).toBe('string');
    expect(options).toEqual({ onConflict: 'user_id' });
  });

  it('maps migration state fields onto the row when provided', async () => {
    await upsertRemoteSyncAccount('migrating_to_e2ee', {
      id: 'mig-1',
      direction: 'enable',
      ownerDeviceId: 'dev-9',
      startedAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
      completedAt: '2026-05-03T00:00:00.000Z',
      plaintextHighWaterMark: '2026-05-04T00:00:00.000Z',
    });

    const [row] = h.upsertMock.mock.calls[0];
    expect(row).toMatchObject({
      sync_mode: 'migrating_to_e2ee',
      e2ee_migration_id: 'mig-1',
      e2ee_migration_direction: 'enable',
      migration_owner_device_id: 'dev-9',
      migration_started_at: '2026-05-01T00:00:00.000Z',
      migration_updated_at: '2026-05-02T00:00:00.000Z',
      migration_completed_at: '2026-05-03T00:00:00.000Z',
      plaintext_high_water_mark: '2026-05-04T00:00:00.000Z',
    });
  });

  it('propagates supabase upsert errors', async () => {
    h.upsertMock.mockResolvedValueOnce({ error: new Error('rls-denied') });
    await expect(upsertRemoteSyncAccount('plain')).rejects.toThrow('rls-denied');
  });

  it('rejects when there is no authenticated user', async () => {
    h.getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(upsertRemoteSyncAccount('plain')).rejects.toThrow(/sign in/i);
    expect(h.upsertMock).not.toHaveBeenCalled();
  });
});

describe('advanceSyncTransitionPhase', () => {
  it('advances an owned transition through the guarded RPC', async () => {
    await advanceSyncTransitionPhase({
      migrationId: 'migration-1',
      ownerDeviceId: 'device-1',
      phase: 'transferring',
    });

    expect(h.rpcMock).toHaveBeenCalledWith('advance_sync_transition_phase', {
      p_migration_id: 'migration-1',
      p_owner_device_id: 'device-1',
      p_phase: 'transferring',
    });
  });
});

describe('abandonSyncTransition', () => {
  it('abandons only through the guarded RPC', async () => {
    await abandonSyncTransition({ migrationId: 'migration-1', ownerDeviceId: 'device-1' });

    expect(h.rpcMock).toHaveBeenCalledWith('abandon_sync_transition', {
      p_migration_id: 'migration-1',
      p_owner_device_id: 'device-1',
    });
  });
});

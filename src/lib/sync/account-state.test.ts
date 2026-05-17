import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  fromMock: vi.fn(),
  getUserMock: vi.fn(),
}));

vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => h.getUserMock(...args) },
    from: (...args: unknown[]) => h.fromMock(...args),
  },
}));

import {
  getDeviceId,
  requireAuthenticatedUser,
  upsertRemoteSyncAccount,
} from './account-state';

beforeEach(() => {
  localStorage.clear();
  h.upsertMock.mockReset();
  h.fromMock.mockReset();
  h.getUserMock.mockReset();
  h.upsertMock.mockResolvedValue({ error: null });
  h.fromMock.mockImplementation(() => ({ upsert: h.upsertMock }));
  h.getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
});

afterEach(() => {
  localStorage.clear();
});

describe('getDeviceId', () => {
  it('generates and persists a new device id on first call', () => {
    expect(localStorage.getItem('evolvtrack-device-id')).toBeNull();
    const id = getDeviceId();
    expect(id).toBeTruthy();
    expect(localStorage.getItem('evolvtrack-device-id')).toBe(id);
  });

  it('returns the same id on subsequent calls (stable per device)', () => {
    const first = getDeviceId();
    const second = getDeviceId();
    expect(second).toBe(first);
  });

  it('honors a pre-existing id in localStorage', () => {
    localStorage.setItem('evolvtrack-device-id', 'preset-device-id');
    expect(getDeviceId()).toBe('preset-device-id');
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

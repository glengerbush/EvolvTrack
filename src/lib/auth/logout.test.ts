import '../../test/dexie-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/db/schema';

const h = vi.hoisted(() => ({
  signOut: vi.fn(),
  syncNow: vi.fn(),
  erase: vi.fn(),
}));

vi.mock('$lib/auth/supabase', () => ({
  supabase: { auth: { signOut: h.signOut } },
}));

vi.mock('$lib/sync/sync-orchestrator', () => ({
  syncNow: h.syncNow,
}));

vi.mock('$lib/security/device-data-erasure', () => ({
  beginDeviceDataErasure: h.erase,
}));

import { logoutCurrentDevice } from './logout';

const timestamp = '2026-08-07T12:00:00.000Z';

async function pending(
  id: string,
  aggregate: 'entry' | 'prescription' | 'profile',
  op: 'upsert' | 'delete' = 'upsert',
) {
  await db.outbox.put({
    id: `${aggregate}:${id}`,
    aggregate,
    entityId: id,
    op,
    updatedAt: timestamp,
    payload: op === 'delete' ? null : { id },
    enqueuedAt: timestamp,
    rev: `rev-${id}`,
  });
}

beforeEach(() => {
  h.signOut.mockReset().mockResolvedValue({ error: null });
  h.syncNow.mockReset().mockResolvedValue(undefined);
  h.erase.mockReset().mockImplementation(async (afterMarked?: () => Promise<void>) => {
    await afterMarked?.();
  });
});

describe('logout orchestration', () => {
  it('requires a choice without attempting sync or logout', async () => {
    await pending('entry-1', 'entry');

    await expect(logoutCurrentDevice('require-synced')).resolves.toEqual({
      status: 'confirmation-required',
      pending: { total: 1, healthEntries: 1, vials: 0, settings: 0 },
    });
    expect(h.syncNow).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.erase).not.toHaveBeenCalled();
  });

  it('logs out directly when nothing is pending', async () => {
    await expect(logoutCurrentDevice('require-synced')).resolves.toEqual({ status: 'complete' });

    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(h.erase).toHaveBeenCalledOnce();
  });

  it('durably begins erasure before revoking the remote session', async () => {
    h.erase.mockImplementationOnce(async (afterMarked?: () => Promise<void>) => {
      expect(h.signOut).not.toHaveBeenCalled();
      await afterMarked?.();
    });

    await logoutCurrentDevice('require-synced');

    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('syncs only after explicit consent and rechecks before logout', async () => {
    await pending('entry-1', 'entry');
    h.syncNow.mockImplementationOnce(async () => {
      await db.outbox.clear();
    });

    await expect(logoutCurrentDevice('sync-first')).resolves.toEqual({ status: 'complete' });

    expect(h.syncNow).toHaveBeenCalledOnce();
    expect(h.signOut).toHaveBeenCalledOnce();
    expect(h.erase).toHaveBeenCalledOnce();
  });

  it('stays signed in when requested sync leaves changes pending', async () => {
    await pending('entry-1', 'entry');

    await expect(logoutCurrentDevice('sync-first')).resolves.toEqual({
      status: 'sync-incomplete',
      pending: { total: 1, healthEntries: 1, vials: 0, settings: 0 },
    });
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.erase).not.toHaveBeenCalled();
  });

  it('erases pending changes only after explicit destructive consent', async () => {
    await pending('entry-1', 'entry');

    await expect(logoutCurrentDevice('discard')).resolves.toEqual({ status: 'complete' });

    expect(h.syncNow).not.toHaveBeenCalled();
    expect(h.signOut).toHaveBeenCalledOnce();
    expect(h.erase).toHaveBeenCalledOnce();
  });

  it('still erases locally when server logout fails', async () => {
    h.signOut.mockRejectedValueOnce(new Error('offline'));

    await expect(logoutCurrentDevice('require-synced')).resolves.toEqual({ status: 'complete' });

    expect(h.erase).toHaveBeenCalledOnce();
  });
});

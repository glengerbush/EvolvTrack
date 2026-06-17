// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const h = vi.hoisted(() => {
  const pullImpl = vi.fn();
  const pushImpl = vi.fn();
  const getUserIdImpl = vi.fn();
  const wizardPendingImpl = vi.fn();
  const fetchRemoteSyncAccountImpl = vi.fn();
  const autoResumeMigrationImpl = vi.fn();
  const getProfileImpl = vi.fn();
  const setLocalSyncStateImpl = vi.fn();
  const getLocalWrappedKeysImpl = vi.fn();
  const fetchRemoteWrappedKeysImpl = vi.fn();
  const saveLocalWrappedKeysImpl = vi.fn();
  const clearLocalWrappedKeysImpl = vi.fn();
  const clearSessionImpl = vi.fn();
  const clearPullCursorImpl = vi.fn();
  const channelOn = vi.fn();
  const channelSubscribe = vi.fn();
  const removeChannel = vi.fn();
  const channelObj = { on: channelOn, subscribe: channelSubscribe };
  const channelFn = vi.fn((_name: string) => channelObj);
  const authUnsubscribe = vi.fn();
  const authCallbacks: Array<(event: string, session: unknown) => void> = [];
  const onAuthStateChange = vi.fn((cb: (event: string, session: unknown) => void) => {
    authCallbacks.push(cb);
    return { data: { subscription: { unsubscribe: authUnsubscribe } } };
  });
  const outboxListeners = new Set<() => void>();
  return {
    pullImpl,
    pushImpl,
    getUserIdImpl,
    wizardPendingImpl,
    fetchRemoteSyncAccountImpl,
    autoResumeMigrationImpl,
    getProfileImpl,
    setLocalSyncStateImpl,
    getLocalWrappedKeysImpl,
    fetchRemoteWrappedKeysImpl,
    saveLocalWrappedKeysImpl,
    clearLocalWrappedKeysImpl,
    clearSessionImpl,
    clearPullCursorImpl,
    channelOn,
    channelSubscribe,
    removeChannel,
    channelObj,
    channelFn,
    authUnsubscribe,
    authCallbacks,
    onAuthStateChange,
    outboxListeners,
  };
});

vi.mock('$lib/sync/sync-engine', () => ({
  pullAndApply: () => h.pullImpl(),
  pushOutbox: () => h.pushImpl(),
}));

vi.mock('$lib/sync/account-state', () => ({
  getAuthenticatedUserId: () => h.getUserIdImpl(),
  fetchRemoteSyncAccount: () => h.fetchRemoteSyncAccountImpl(),
}));

vi.mock('$lib/sync/e2ee-migration', () => ({
  autoResumeMigration: () => h.autoResumeMigrationImpl(),
}));

vi.mock('$lib/domain/repo', () => ({
  onOutboxChange: (listener: () => void) => {
    h.outboxListeners.add(listener);
    return () => h.outboxListeners.delete(listener);
  },
  getProfile: () => h.getProfileImpl(),
  getProfileSyncMode: (profile: { syncMode?: string } | undefined) =>
    (profile?.syncMode ?? 'plain') as string,
  setLocalProfileSyncState: (state: unknown) => h.setLocalSyncStateImpl(state),
}));

vi.mock('$lib/sync/wrapped-keys', () => ({
  getLocalWrappedKeys: () => h.getLocalWrappedKeysImpl(),
  fetchRemoteWrappedKeys: () => h.fetchRemoteWrappedKeysImpl(),
  saveLocalWrappedKeys: (bundle: unknown) => h.saveLocalWrappedKeysImpl(bundle),
  clearLocalWrappedKeys: () => h.clearLocalWrappedKeysImpl(),
}));

vi.mock('$lib/sync/pull-cursor', () => ({
  clearPullCursor: () => h.clearPullCursorImpl(),
}));

vi.mock('$lib/sync/session-key', () => ({
  rehydrateSession: () => undefined,
  clearSession: () => h.clearSessionImpl(),
}));

vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    channel: (name: string) => h.channelFn(name),
    removeChannel: (channel: unknown) => h.removeChannel(channel),
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) =>
        h.onAuthStateChange(cb),
    },
  },
  supabaseUrl: 'https://example.supabase.co',
  // Best-effort server-clock probe — stubbed so the cycle never hits the network.
  fetchServerTimeMs: async () => null,
}));

vi.mock('$lib/stores/setupWizardStore', () => ({
  isSetupWizardPending: () => h.wizardPendingImpl(),
}));

import {
  connectivity,
  lastSyncError,
  lastSynced,
  migrationResumePending,
  migrationTakeoverAvailable,
  syncStatus,
} from '$lib/stores/syncStore';
import {
  SYNC_DEBOUNCE_MS,
  createSyncOrchestrator,
  startSyncOrchestrator,
} from './sync-orchestrator';

/** Flush a handful of microtask turns (the cycle awaits several promises:
 *  auth, license, reconcile, the migration-resume check, then pull). */
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.pullImpl.mockReset().mockResolvedValue({ fetched: 0, applied: 0 });
  h.pushImpl.mockReset().mockResolvedValue({ pushed: 0 });
  h.getUserIdImpl.mockReset().mockResolvedValue('user-1');
  h.wizardPendingImpl.mockReset().mockReturnValue(false);
  h.fetchRemoteSyncAccountImpl.mockReset().mockResolvedValue(null);
  h.autoResumeMigrationImpl.mockReset().mockResolvedValue({ status: 'idle' });
  h.getProfileImpl.mockReset().mockResolvedValue(undefined);
  h.setLocalSyncStateImpl.mockReset().mockResolvedValue(undefined);
  h.getLocalWrappedKeysImpl.mockReset().mockResolvedValue(undefined);
  h.fetchRemoteWrappedKeysImpl.mockReset().mockResolvedValue(null);
  h.saveLocalWrappedKeysImpl.mockReset().mockResolvedValue(undefined);
  h.clearLocalWrappedKeysImpl.mockReset().mockResolvedValue(undefined);
  h.clearSessionImpl.mockReset();
  h.clearPullCursorImpl.mockReset();
  h.channelOn.mockReset().mockReturnValue(h.channelObj);
  h.channelSubscribe.mockReset().mockReturnValue(h.channelObj);
  h.channelFn.mockClear();
  h.removeChannel.mockReset();
  h.onAuthStateChange.mockClear();
  h.authUnsubscribe.mockReset();
  h.authCallbacks.length = 0;
  h.outboxListeners.clear();
  setOnline(true);
  syncStatus.set('idle');
  connectivity.set('connecting');
  lastSyncError.set(null);
  migrationResumePending.set(null);
  migrationTakeoverAvailable.set(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSyncOrchestrator — runCycle', () => {
  it('runs pull then push and lands on idle', async () => {
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.pullImpl).toHaveBeenCalledTimes(1);
    expect(h.pushImpl).toHaveBeenCalledTimes(1);
    expect(h.pullImpl.mock.invocationCallOrder[0]).toBeLessThan(
      h.pushImpl.mock.invocationCallOrder[0],
    );
    expect(get(syncStatus)).toBe('idle');
  });

  it('records "last synced" on a clean cycle even when no rows moved', async () => {
    // Default mocks return fetched:0 / pushed:0 — the "already up to date"
    // case. This is the bug the indicator had: a no-op Sync now must still
    // refresh the timestamp.
    const spy = vi.spyOn(lastSynced, 'record');
    try {
      const orchestrator = createSyncOrchestrator();
      await orchestrator.syncNow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not record "last synced" when the cycle fails', async () => {
    h.pullImpl.mockRejectedValueOnce(new Error('rls-denied'));
    const spy = vi.spyOn(lastSynced, 'record');
    try {
      const orchestrator = createSyncOrchestrator();
      await orchestrator.syncNow();
      expect(get(syncStatus)).toBe('error');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports `syncing` while a cycle is in flight', async () => {
    let resolvePull: (() => void) | undefined;
    h.pullImpl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePull = () => resolve({ fetched: 0, applied: 0 });
      }),
    );
    const orchestrator = createSyncOrchestrator();
    const cycle = orchestrator.syncNow();
    await flush();

    expect(get(syncStatus)).toBe('syncing');
    resolvePull?.();
    await cycle;
    expect(get(syncStatus)).toBe('idle');
  });

  it('skips when the device is offline, reporting connectivity rather than a sync error', async () => {
    setOnline(false);
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(get(connectivity)).toBe('offline');
    expect(get(syncStatus)).toBe('idle');
    expect(h.pullImpl).not.toHaveBeenCalled();
    expect(h.pushImpl).not.toHaveBeenCalled();
  });

  it('skips quietly (idle) when signed out', async () => {
    h.getUserIdImpl.mockResolvedValue(null);
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(get(syncStatus)).toBe('idle');
    expect(h.pullImpl).not.toHaveBeenCalled();
  });

  it('pulls but does not push while the setup wizard is pending', async () => {
    h.wizardPendingImpl.mockReturnValue(true);
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.pullImpl).toHaveBeenCalledTimes(1);
    expect(h.pushImpl).not.toHaveBeenCalled();
    expect(get(syncStatus)).toBe('idle');
  });

  it('lands on `error` when a cycle throws, without surfacing it', async () => {
    h.pullImpl.mockRejectedValueOnce(new Error('rls-denied'));
    const orchestrator = createSyncOrchestrator();
    await expect(orchestrator.syncNow()).resolves.toBeUndefined();

    expect(get(syncStatus)).toBe('error');
    expect(h.pushImpl).not.toHaveBeenCalled();
  });

  it('reconciles to e2ee when the server says e2ee but local is plain — fetching the wrapped bundle and clearing the cursor', async () => {
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'e2ee' });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'plain' });
    h.getLocalWrappedKeysImpl.mockResolvedValue(undefined);
    h.fetchRemoteWrappedKeysImpl.mockResolvedValue({
      id: 'self',
      passphraseSaltB64: 's',
      passphraseWrapped: { ciphertext: 'c', iv: 'i' },
      recoverySaltB64: 'r',
      recoveryWrapped: { ciphertext: 'rc', iv: 'ri' },
      dekVersion: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.setLocalSyncStateImpl).toHaveBeenCalledWith(
      expect.objectContaining({ syncMode: 'e2ee', passphraseEnabled: true }),
    );
    expect(h.saveLocalWrappedKeysImpl).toHaveBeenCalledTimes(1);
    expect(h.clearPullCursorImpl).toHaveBeenCalledTimes(1);
  });

  it('downgrades to plain when the server says plain but local is still e2ee', async () => {
    // The account owner disabled E2EE on another device; this device must follow
    // it down to plain, dropping its key material — otherwise its encrypted
    // writes get rejected by the server's RLS.
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'plain' });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'e2ee' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.clearLocalWrappedKeysImpl).toHaveBeenCalledTimes(1);
    expect(h.clearSessionImpl).toHaveBeenCalledTimes(1);
    expect(h.clearPullCursorImpl).toHaveBeenCalledTimes(1);
    expect(h.setLocalSyncStateImpl).toHaveBeenCalledWith(
      expect.objectContaining({ syncMode: 'plain', passphraseEnabled: false }),
    );
  });

  it('does not downgrade when both server and local are already plain', async () => {
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'plain' });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'plain' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.clearLocalWrappedKeysImpl).not.toHaveBeenCalled();
    expect(h.setLocalSyncStateImpl).not.toHaveBeenCalled();
  });

  it('drops the stale key and re-locks when a rotation advanced the DEK version elsewhere', async () => {
    // Server finished a rotation (active version 2); this device still holds v1.
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'e2ee', activeDekVersion: 2 });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'e2ee' });
    h.getLocalWrappedKeysImpl.mockResolvedValue({ id: 'self', dekVersion: 1 });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.clearLocalWrappedKeysImpl).toHaveBeenCalledTimes(1);
    expect(h.clearSessionImpl).toHaveBeenCalledTimes(1);
    expect(h.clearPullCursorImpl).toHaveBeenCalledTimes(1);
    // Stays e2ee locally (so the unlock gate fires) — no mode flip written.
    expect(h.setLocalSyncStateImpl).not.toHaveBeenCalled();
  });

  it('does not re-lock when the active DEK version matches the local bundle', async () => {
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'e2ee', activeDekVersion: 1 });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'e2ee' });
    h.getLocalWrappedKeysImpl.mockResolvedValue({ id: 'self', dekVersion: 1 });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.clearLocalWrappedKeysImpl).not.toHaveBeenCalled();
    expect(h.clearSessionImpl).not.toHaveBeenCalled();
  });

  it('carries the in-flight migration record onto a fresh device', async () => {
    const migration = {
      id: 'mig-1',
      direction: 'enable',
      ownerDeviceId: 'other-device',
      startedAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
    };
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'migrating_to_e2ee', migration });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'plain' });
    h.getLocalWrappedKeysImpl.mockResolvedValue({ id: 'self' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    // Without the migration record a fresh device couldn't offer to take over.
    expect(h.setLocalSyncStateImpl).toHaveBeenCalledWith(
      expect.objectContaining({ syncMode: 'migrating_to_e2ee', e2eeMigration: migration }),
    );
  });

  it('converges a watcher out of migrating mode once the migration finishes elsewhere', async () => {
    // Regression: device watched another device's enable migration (so it is
    // locally pinned in 'migrating_to_e2ee' with that device's migration
    // record). The owner finished, so the server is now steady-state 'e2ee'
    // with no migration. The watcher must adopt the steady state — otherwise it
    // stays mid-migration forever and the take-over modal flaps on/off as the
    // poll clears it and the next cycle re-derives an 'awaiting-takeover' offer.
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'e2ee', activeDekVersion: 1 });
    h.getProfileImpl.mockResolvedValue({
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: { id: 'mig-1', ownerDeviceId: 'other-device' },
    });
    h.getLocalWrappedKeysImpl.mockResolvedValue({ id: 'self', dekVersion: 1 });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.setLocalSyncStateImpl).toHaveBeenCalledWith(
      expect.objectContaining({ syncMode: 'e2ee', e2eeMigration: undefined }),
    );
    expect(h.clearPullCursorImpl).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile when the server has no sync_accounts row (brand-new user)', async () => {
    h.fetchRemoteSyncAccountImpl.mockResolvedValue(null);
    h.getProfileImpl.mockResolvedValue({ syncMode: 'plain' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.setLocalSyncStateImpl).not.toHaveBeenCalled();
    expect(h.clearPullCursorImpl).not.toHaveBeenCalled();
  });

  it('does not reconcile when local is already encrypted (no-op when in sync)', async () => {
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'e2ee' });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'e2ee' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.setLocalSyncStateImpl).not.toHaveBeenCalled();
    expect(h.fetchRemoteWrappedKeysImpl).not.toHaveBeenCalled();
    expect(h.clearPullCursorImpl).not.toHaveBeenCalled();
  });

  it('skips the bundle fetch when one is already cached locally', async () => {
    h.fetchRemoteSyncAccountImpl.mockResolvedValue({ syncMode: 'e2ee' });
    h.getProfileImpl.mockResolvedValue({ syncMode: 'plain' });
    h.getLocalWrappedKeysImpl.mockResolvedValue({ id: 'self' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.fetchRemoteWrappedKeysImpl).not.toHaveBeenCalled();
    expect(h.saveLocalWrappedKeysImpl).not.toHaveBeenCalled();
    expect(h.setLocalSyncStateImpl).toHaveBeenCalledWith(
      expect.objectContaining({ syncMode: 'e2ee' }),
    );
  });

  it('fails the cycle into `error` when the sync_mode probe throws', async () => {
    h.fetchRemoteSyncAccountImpl.mockRejectedValueOnce(new Error('rpc-failed'));

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(get(syncStatus)).toBe('error');
    // Pull must not run on stale assumptions when we couldn't verify the mode.
    expect(h.pullImpl).not.toHaveBeenCalled();
    expect(h.pushImpl).not.toHaveBeenCalled();
  });

  it('coalesces an overlapping request into a single rerun', async () => {
    let resolveFirstPull: (() => void) | undefined;
    h.pullImpl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirstPull = () => resolve({ fetched: 0, applied: 0 });
      }),
    );
    const orchestrator = createSyncOrchestrator();

    const first = orchestrator.syncNow();
    await flush();
    // Two more requests while the first cycle is still in flight.
    const second = orchestrator.syncNow();
    const third = orchestrator.syncNow();

    resolveFirstPull?.();
    await Promise.all([first, second, third]);
    await flush();

    // First cycle + exactly one coalesced rerun = 2 (not 3).
    expect(h.pullImpl).toHaveBeenCalledTimes(2);
  });
});

describe('createSyncOrchestrator — scheduleSync', () => {
  it('debounces a burst of triggers into one cycle', async () => {
    const orchestrator = createSyncOrchestrator();
    orchestrator.scheduleSync();
    orchestrator.scheduleSync();
    orchestrator.scheduleSync();

    expect(h.pullImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);

    expect(h.pullImpl).toHaveBeenCalledTimes(1);
  });

  it('does nothing after dispose', async () => {
    const orchestrator = createSyncOrchestrator();
    orchestrator.dispose();
    orchestrator.scheduleSync();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);

    expect(h.pullImpl).not.toHaveBeenCalled();
  });
});

describe('startSyncOrchestrator — glue', () => {
  it('triggers a debounced sync on window focus and online events', async () => {
    const teardown = startSyncOrchestrator();
    try {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
      expect(h.pullImpl).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
      expect(h.pullImpl).toHaveBeenCalledTimes(2);
    } finally {
      teardown();
    }
  });

  it('triggers a debounced sync when the outbox changes', async () => {
    const teardown = startSyncOrchestrator();
    try {
      for (const listener of h.outboxListeners) listener();
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
      expect(h.pullImpl).toHaveBeenCalledTimes(1);
    } finally {
      teardown();
    }
  });

  it('subscribes a per-user Realtime channel when a session is present', () => {
    const teardown = startSyncOrchestrator();
    try {
      h.authCallbacks[0]?.('SIGNED_IN', { user: { id: 'user-9' } });

      expect(h.channelFn).toHaveBeenCalledWith('sync-changes');
      // Both change tables, filtered to this user.
      const filters = h.channelOn.mock.calls.map((c) => c[1]);
      expect(filters).toEqual([
        expect.objectContaining({ table: 'sync_changes_encrypted', filter: 'user_id=eq.user-9' }),
        expect.objectContaining({ table: 'sync_changes_plain', filter: 'user_id=eq.user-9' }),
      ]);
      expect(h.channelSubscribe).toHaveBeenCalled();
    } finally {
      teardown();
    }
  });

  it('does not subscribe a channel when signed out', () => {
    const teardown = startSyncOrchestrator();
    try {
      h.authCallbacks[0]?.('SIGNED_OUT', null);
      expect(h.channelFn).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });

  it('teardown removes window listeners, the channel, and the auth subscription', async () => {
    const teardown = startSyncOrchestrator();
    h.authCallbacks[0]?.('SIGNED_IN', { user: { id: 'user-9' } });
    teardown();

    expect(h.authUnsubscribe).toHaveBeenCalled();
    expect(h.removeChannel).toHaveBeenCalledWith(h.channelObj);

    // A focus event after teardown must not trigger another sync.
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
    expect(h.pullImpl).not.toHaveBeenCalled();
  });
});

describe('createSyncOrchestrator — migration auto-resume', () => {
  it('offers a take-over (and halts) when the migration is owned by another device', async () => {
    h.autoResumeMigrationImpl.mockResolvedValue({
      status: 'awaiting-takeover',
      direction: 'enable',
      ownerDeviceId: 'other-device',
    });
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(get(migrationTakeoverAvailable)).toEqual({
      direction: 'enable',
      ownerDeviceId: 'other-device',
    });
    // Don't drive someone else's migration, and don't prompt for a passphrase.
    expect(get(migrationResumePending)).toBeNull();
    expect(h.pullImpl).not.toHaveBeenCalled();
    expect(h.pushImpl).not.toHaveBeenCalled();
    expect(get(syncStatus)).toBe('idle');
  });

  it('clears a stale take-over offer once the migration is no longer foreign', async () => {
    migrationTakeoverAvailable.set({ direction: 'enable', ownerDeviceId: 'other-device' });
    h.autoResumeMigrationImpl.mockResolvedValue({ status: 'idle' });
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();
    expect(get(migrationTakeoverAvailable)).toBeNull();
  });

  it('halts the cycle and flags the passphrase prompt when locked mid-migration', async () => {
    h.autoResumeMigrationImpl.mockResolvedValue({
      status: 'needs-passphrase',
      direction: 'enable',
    });
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(get(migrationResumePending)).toBe('enable');
    // Steady-state sync stays paused while waiting on the user's passphrase.
    expect(h.pullImpl).not.toHaveBeenCalled();
    expect(h.pushImpl).not.toHaveBeenCalled();
    expect(get(syncStatus)).toBe('idle');
  });

  it('clears the flag and runs a normal sync once a resume completes', async () => {
    h.autoResumeMigrationImpl.mockResolvedValue({
      status: 'resumed',
      result: { completed: true },
    });
    migrationResumePending.set('enable');
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(get(migrationResumePending)).toBeNull();
    // Back in a steady-state mode, the cycle proceeds to pull + push.
    expect(h.pullImpl).toHaveBeenCalledTimes(1);
    expect(h.pushImpl).toHaveBeenCalledTimes(1);
    expect(get(syncStatus)).toBe('idle');
  });

  it('surfaces the error and skips sync when a resume attempt fails (paused)', async () => {
    h.autoResumeMigrationImpl.mockResolvedValue({
      status: 'paused',
      result: { completed: false, error: 'boom' },
    });
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(get(lastSyncError)).toBe('boom');
    expect(get(syncStatus)).toBe('error');
    expect(h.pullImpl).not.toHaveBeenCalled();
  });

  it('stands down without an error when the migration is taken over mid-run (superseded)', async () => {
    // Simulate a leftover error + resume prompt from before the take-over.
    lastSyncError.set('stale error');
    migrationResumePending.set('enable');
    h.autoResumeMigrationImpl.mockResolvedValue({ status: 'superseded' });
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    // A clean hand-off, not a failure: clear the error/prompt and go idle so the
    // next cycle's reconcile can adopt the new owner. Never an 'error' status.
    expect(get(lastSyncError)).toBeNull();
    expect(get(migrationResumePending)).toBeNull();
    expect(get(syncStatus)).toBe('idle');
    // Don't fall through to steady-state sync while still mid-migration.
    expect(h.pullImpl).not.toHaveBeenCalled();
    expect(h.pushImpl).not.toHaveBeenCalled();
  });

  it('stands down silently (no passphrase prompt) when a run owns the migration in-tab', async () => {
    // Regression: a rotation kicked off in this tab flips the profile to
    // 'rotating_e2ee_key'; an interleaved sync cycle must NOT set a resume
    // prompt from that (which briefly flashed the old/new passphrase modal as
    // the rotation finished). autoResumeMigration reports 'in-progress'.
    migrationResumePending.set(null);
    h.autoResumeMigrationImpl.mockResolvedValue({ status: 'in-progress' });
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    // The in-tab run drives its own modal; the orchestrator leaves it alone.
    expect(get(migrationResumePending)).toBeNull();
    expect(get(syncStatus)).toBe('idle');
    expect(h.pullImpl).not.toHaveBeenCalled();
    expect(h.pushImpl).not.toHaveBeenCalled();
  });

  it('does not attempt a resume when signed out', async () => {
    h.getUserIdImpl.mockResolvedValue(null);
    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();
    expect(h.autoResumeMigrationImpl).not.toHaveBeenCalled();
  });
});

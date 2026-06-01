// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const h = vi.hoisted(() => {
  const pullImpl = vi.fn();
  const pushImpl = vi.fn();
  const getUserIdImpl = vi.fn();
  const wizardPendingImpl = vi.fn();
  const fetchRemoteSyncModeImpl = vi.fn();
  const getProfileImpl = vi.fn();
  const setLocalSyncStateImpl = vi.fn();
  const getLocalWrappedKeysImpl = vi.fn();
  const fetchRemoteWrappedKeysImpl = vi.fn();
  const saveLocalWrappedKeysImpl = vi.fn();
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
    fetchRemoteSyncModeImpl,
    getProfileImpl,
    setLocalSyncStateImpl,
    getLocalWrappedKeysImpl,
    fetchRemoteWrappedKeysImpl,
    saveLocalWrappedKeysImpl,
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
  fetchRemoteSyncMode: () => h.fetchRemoteSyncModeImpl(),
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
}));

vi.mock('$lib/sync/pull-cursor', () => ({
  clearPullCursor: () => h.clearPullCursorImpl(),
}));

vi.mock('$lib/sync/session-key', () => ({
  rehydrateSession: () => undefined,
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
}));

vi.mock('$lib/stores/setupWizardStore', () => ({
  isSetupWizardPending: () => h.wizardPendingImpl(),
}));

import { connectivity, lastSynced, syncStatus } from '$lib/stores/syncStore';
import {
  SYNC_DEBOUNCE_MS,
  createSyncOrchestrator,
  startSyncOrchestrator,
} from './sync-orchestrator';

/** Flush a handful of microtask turns (the cycle awaits a couple of promises). */
async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
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
  h.fetchRemoteSyncModeImpl.mockReset().mockResolvedValue(null);
  h.getProfileImpl.mockReset().mockResolvedValue(undefined);
  h.setLocalSyncStateImpl.mockReset().mockResolvedValue(undefined);
  h.getLocalWrappedKeysImpl.mockReset().mockResolvedValue(undefined);
  h.fetchRemoteWrappedKeysImpl.mockReset().mockResolvedValue(null);
  h.saveLocalWrappedKeysImpl.mockReset().mockResolvedValue(undefined);
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
    h.fetchRemoteSyncModeImpl.mockResolvedValue('e2ee');
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

  it('does not reconcile when the server has no sync_accounts row (brand-new user)', async () => {
    h.fetchRemoteSyncModeImpl.mockResolvedValue(null);
    h.getProfileImpl.mockResolvedValue({ syncMode: 'plain' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.setLocalSyncStateImpl).not.toHaveBeenCalled();
    expect(h.clearPullCursorImpl).not.toHaveBeenCalled();
  });

  it('does not reconcile when local is already encrypted (no-op when in sync)', async () => {
    h.fetchRemoteSyncModeImpl.mockResolvedValue('e2ee');
    h.getProfileImpl.mockResolvedValue({ syncMode: 'e2ee' });

    const orchestrator = createSyncOrchestrator();
    await orchestrator.syncNow();

    expect(h.setLocalSyncStateImpl).not.toHaveBeenCalled();
    expect(h.fetchRemoteWrappedKeysImpl).not.toHaveBeenCalled();
    expect(h.clearPullCursorImpl).not.toHaveBeenCalled();
  });

  it('skips the bundle fetch when one is already cached locally', async () => {
    h.fetchRemoteSyncModeImpl.mockResolvedValue('e2ee');
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
    h.fetchRemoteSyncModeImpl.mockRejectedValueOnce(new Error('rpc-failed'));

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

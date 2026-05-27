/**
 * Background sync orchestration.
 *
 * Split into a testable core and a thin glue layer:
 *  - `createSyncOrchestrator()` is the core — debounce/coalesce logic, the
 *    pull-then-push cycle, status transitions, the concurrency guard. It has
 *    no knowledge of the DOM or Realtime, so it is unit-testable with fake
 *    timers and mocked sync-engine functions.
 *  - `startSyncOrchestrator()` is the glue — wires window focus/online events,
 *    the outbox-change nudge, and a Supabase Realtime subscription into the
 *    core, and tears them all down again. It also re-targets Realtime on auth
 *    state changes.
 */
import { get } from 'svelte/store';
import { pullAndApply, pushOutbox } from '$lib/sync/sync-engine';
import { fetchRemoteSyncMode, getAuthenticatedUserId } from '$lib/sync/account-state';
import { refreshLicenseActive } from '$lib/sync/license';
import { getProfile, getProfileSyncMode, onOutboxChange, setLocalProfileSyncState } from '$lib/domain/repo';
import { fetchRemoteWrappedKeys, getLocalWrappedKeys, saveLocalWrappedKeys } from '$lib/sync/wrapped-keys';
import { clearPullCursor } from '$lib/sync/pull-cursor';
import { supabase, supabaseUrl } from '$lib/auth/supabase';
import { isSetupWizardPending } from '$lib/stores/setupWizardStore';
import { rehydrateSession } from '$lib/sync/session-key';
import type { SyncMode } from '$lib/domain/types';
import {
  connectivity,
  lastPullAt,
  lastPushAt,
  lastSyncError,
  licenseActive,
  syncStatus,
} from '$lib/stores/syncStore';

/** How long to coalesce a burst of triggers into a single sync cycle. */
export const SYNC_DEBOUNCE_MS = 1200;

export type SyncOrchestrator = {
  /** Trigger a debounced sync cycle (coalesces rapid calls). */
  scheduleSync(): void;
  /** Run a sync cycle immediately, bypassing the debounce. */
  syncNow(): Promise<void>;
  /** Stop the orchestrator; pending debounced work is cancelled. */
  dispose(): void;
};

function browserSaysOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function looksLikeNetworkError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /network|fetch|ECONN|timeout|offline|reach/i.test(message);
}

/**
 * Honest reachability check used by the signed-out path and at startup.
 * Pings the Supabase auth health endpoint; any HTTP response (even an error
 * status) proves the network reached a server. Only thrown fetch errors
 * (DNS, timeout, refused) count as offline.
 */
async function probeReachable(): Promise<boolean> {
  if (typeof fetch === 'undefined') return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(`${supabaseUrl}/auth/v1/health`, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
      return true;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function isEncryptedMode(mode: SyncMode): boolean {
  return mode === 'e2ee' || mode === 'migrating_to_e2ee' || mode === 'rotating_e2ee_key';
}

/**
 * If the server's `sync_accounts.sync_mode` disagrees with this device's
 * local profile in the privacy-sensitive direction (server: encrypted,
 * local: plain), flip the device to match. Also caches the remote wrapped-
 * key bundle so the unlock modal has something to work with. The pull cursor
 * is reset because it points into the old table's `inserted_at` sequence.
 *
 * Deliberately one-way for now: the encrypted→plain transition is gated by
 * the explicit `startE2EEDisableMigration` flow on the device that owns the
 * change, and forcing a remote downgrade here would risk losing in-flight
 * encrypted local edits.
 */
async function reconcileSyncMode(): Promise<void> {
  const remoteMode = await fetchRemoteSyncMode();
  if (!remoteMode) return;
  if (!isEncryptedMode(remoteMode)) return;

  const profile = await getProfile();
  const localMode = getProfileSyncMode(profile);
  if (isEncryptedMode(localMode)) return;

  // Make sure the wrapped-key bundle is available locally so UnlockSessionModal
  // can derive the DEK from the user's passphrase. Best-effort: if the fetch
  // fails (network blip), the unlock screen will retry on its own path.
  if (!(await getLocalWrappedKeys())) {
    try {
      const remoteBundle = await fetchRemoteWrappedKeys();
      if (remoteBundle) {
        const { id: _id, ...rest } = remoteBundle;
        await saveLocalWrappedKeys(rest);
      }
    } catch (cause) {
      console.warn('Failed to fetch remote wrapped-key bundle during reconcile:', cause);
    }
  }

  await setLocalProfileSyncState({ syncMode: remoteMode, passphraseEnabled: true });
  clearPullCursor();
}

export function createSyncOrchestrator(): SyncOrchestrator {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerunQueued = false;
  let disposed = false;

  async function runCycle(): Promise<void> {
    if (disposed) return;
    // Set synchronously, before any await, so two callers can't both pass.
    if (running) {
      rerunQueued = true;
      return;
    }
    running = true;

    try {
      if (browserSaysOffline()) {
        connectivity.set('offline');
        syncStatus.set('idle');
        return;
      }
      // Signed out (or demo) — nothing to sync; not an error. Leave
      // connectivity alone: `getUser()` doesn't hit the network when there's
      // no cached session, so we have no proof of reachability either way.
      // The browser online/offline events drive connectivity in this path.
      const userId = await getAuthenticatedUserId();
      if (!userId) {
        syncStatus.set('idle');
        return;
      }

      // Cloud sync is gated by an active license. If we don't know the state
      // yet, fetch it once. If inactive, skip the cycle entirely — no pull,
      // no push, no connectivity check, no error. The pill renders this as
      // 'no-license' rather than 'error'.
      if (get(licenseActive) === null) {
        try {
          await refreshLicenseActive();
        } catch {
          // License RPC failed (network/auth). Leave state unknown and let
          // the cycle proceed; if push then fails for a different reason it
          // will surface as a normal error.
        }
      }
      if (get(licenseActive) === false) {
        syncStatus.set('idle');
        lastSyncError.set(null);
        return;
      }

      // Reconcile the local sync mode with what the server says is canonical.
      // Closes a privacy hole: a fresh device (PWA install, post-logout
      // re-login) defaults to plain mode locally; without this check it would
      // happily push plaintext to an account the user has switched to E2EE
      // elsewhere. If reconciliation throws, we surface the failure rather
      // than proceed on stale assumptions.
      await reconcileSyncMode();

      syncStatus.set('syncing');
      // Pull first so local LWW-merges remote state (and reconciles the
      // outbox), then push whatever is genuinely newer locally.
      await pullAndApply();
      lastPullAt.set(new Date());
      // Setup wizard gates push so a freshly signed-up user can opt into
      // E2EE before any plaintext leaves the device. Pull stays on so the
      // wizard can react to whatever already exists on the account.
      if (!isSetupWizardPending()) {
        await pushOutbox();
        lastPushAt.set(new Date());
      }
      connectivity.set('online');
      lastSyncError.set(null);
      syncStatus.set('idle');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastSyncError.set(message);
      if (looksLikeNetworkError(error) || browserSaysOffline()) {
        connectivity.set('offline');
        syncStatus.set('idle');
      } else {
        connectivity.set('online');
        syncStatus.set('error');
      }
      console.error('Sync cycle failed:', error);
    } finally {
      running = false;
      if (rerunQueued && !disposed) {
        rerunQueued = false;
        void runCycle();
      }
    }
  }

  function scheduleSync(): void {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runCycle();
    }, SYNC_DEBOUNCE_MS);
  }

  async function syncNow(): Promise<void> {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    await runCycle();
  }

  function dispose(): void {
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  return { scheduleSync, syncNow, dispose };
}

// ── App singleton + glue ───────────────────────────────────────────────────

let appOrchestrator: SyncOrchestrator | null = null;

/**
 * Wire the orchestrator into the running app: window focus/online, the
 * outbox-change nudge, and a per-user Realtime subscription that re-targets
 * itself on auth changes. Returns a teardown function (suitable for an
 * `onMount` cleanup).
 */
export function startSyncOrchestrator(): () => void {
  appOrchestrator?.dispose();
  // Restore a persisted E2EE session key (if the user opted in via the unlock
  // modal) before any sync attempt — otherwise the first cycle would skip with
  // `locked` and the unlock banner would flash on every refresh.
  rehydrateSession();
  const orchestrator = createSyncOrchestrator();
  appOrchestrator = orchestrator;

  const trigger = () => orchestrator.scheduleSync();

  // Honest connectivity: an `online` event means the browser thinks the
  // network came back, but we haven't *confirmed* it reaches Supabase yet —
  // park at `connecting` until the next cycle resolves.
  const onOnline = () => {
    connectivity.set('connecting');
    trigger();
  };
  const onOffline = () => connectivity.set('offline');

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', trigger);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // If the browser is already offline on startup, surface that immediately
    // rather than pretending to be `connecting` for the first 1.2s.
    if (browserSaysOffline()) connectivity.set('offline');
  }
  const offOutbox = onOutboxChange(trigger);

  // Realtime just nudges a sync — the client still pulls by cursor. The
  // subscription is re-targeted whenever the signed-in user changes.
  let channel: ReturnType<typeof supabase.channel> | null = null;
  function teardownChannel() {
    if (channel) {
      void supabase.removeChannel(channel);
      channel = null;
    }
  }
  const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
    teardownChannel();
    const userId = session?.user?.id;
    // Invalidate the license-active cache on any auth transition so the next
    // sync cycle re-fetches for the new user (or skips entirely if signed out).
    licenseActive.set(null);
    if (!userId) return;
    channel = supabase
      .channel('sync-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sync_changes_encrypted', filter: `user_id=eq.${userId}` },
        trigger,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sync_changes_plain', filter: `user_id=eq.${userId}` },
        trigger,
      )
      .subscribe();
    // Catch up on anything missed while this device was away.
    orchestrator.scheduleSync();
  });

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', trigger);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    }
    offOutbox();
    teardownChannel();
    authSub.subscription.unsubscribe();
    orchestrator.dispose();
    if (appOrchestrator === orchestrator) appOrchestrator = null;
  };
}

/** Trigger a debounced sync from anywhere in the app (no-op before start). */
export function requestSync(): void {
  appOrchestrator?.scheduleSync();
}

/** Force an immediate sync — used by the manual "Sync now" button. */
export async function syncNow(): Promise<void> {
  if (appOrchestrator) {
    await appOrchestrator.syncNow();
    return;
  }
  // Not started yet (e.g. called from a test harness) — run a one-off.
  await createSyncOrchestrator().syncNow();
}

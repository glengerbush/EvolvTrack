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
import { e2eeLifecycle } from '$lib/sync/e2ee-lifecycle-runtime';
import { fetchRemoteSyncAccount, getAuthenticatedUserId } from '$lib/sync/account-state';
import { refreshLicenseActive } from '$lib/sync/license';
import { onOutboxChange } from '$lib/domain/health-data-storage';
import { fetchServerTimeMs, supabaseUrl } from '$lib/auth/supabase';
import { recordServerTime } from '$lib/sync/clock';
import { isSetupWizardPending } from '$lib/stores/setupWizardStore';
import { deviceEncryptionState } from '$lib/sync/device-encryption-state';
import { remoteSyncLogTransfer } from '$lib/sync/remote-sync-log-transfer';
import { errorMessage } from '$lib/utils/errorMessage';
import type { SyncMode } from '$lib/domain/types';
import {
  connectivity,
  lastPullAt,
  lastPushAt,
  lastSyncError,
  lastSynced,
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
  /** Stop new work and resolve after the active cycle can no longer write locally. */
  dispose(): Promise<void>;
};

function browserSaysOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function looksLikeNetworkError(error: unknown): boolean {
  if (!error) return false;
  return /network|fetch|ECONN|timeout|offline|reach/i.test(errorMessage(error));
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


/**
 * If the server's `sync_accounts.sync_mode` disagrees with this device's
 * local profile in the privacy-sensitive direction (server: encrypted,
 * local: plain), flip the device to match. Also caches the remote wrapped-
 * key bundle so the unlock modal has something to work with, and carries over
 * the in-flight migration record (so a fresh device knows a migration is
 * underway and who owns it — the input to the take-over banner). The pull
 * cursor is reset because it points into the old table's `inserted_at`
 * sequence.
 *
 * The plain→encrypted flip is one-way: the encrypted→plain transition is gated
 * by the explicit `startE2EEDisableMigration` flow on the owning device, and
 * forcing a remote downgrade here would risk losing in-flight encrypted edits.
 */
async function reconcileSyncMode(): Promise<void> {
  const remote = await fetchRemoteSyncAccount();
  if (!remote) return;
  await deviceEncryptionState.converge(remote);
}

/**
 * Drive an interrupted E2EE migration on this device toward completion before
 * the steady-state pull/push (which is paused for the duration of a migration).
 *
 * Returns `'halt'` when this cycle should stop early — either the migration is
 * waiting on the user's passphrase, or a resume attempt failed and there's
 * nothing more to do until the next trigger. Returns `'continue'` when there's
 * no migration to resume, or one just finished and the cycle can proceed to a
 * normal sync.
 */
async function resumeMigrationIfNeeded(): Promise<'continue' | 'halt'> {
  const resume = await e2eeLifecycle.reconcile();

  if (resume.status === 'in-progress') {
    // A migration run owns the transition in this tab (started from settings,
    // or the modal's Resume). It drives its own lifecycle snapshot; a second
    // reconcile could briefly publish a stale credential prompt. Pull/push are gated during
    // a migration anyway, so there's nothing else to do this cycle.
    syncStatus.set('idle');
    return 'halt';
  }

  if (resume.status === 'awaiting-takeover') {
    // A migration owned by another device. Don't drive it; offer the user a
    // "take over on this device" banner instead. Pull/push are gated during a
    // migration anyway, so there's nothing else to do this cycle.
    syncStatus.set('idle');
    return 'halt';
  }

  if (resume.status === 'superseded') {
    // This device was driving the migration but another device took it over
    // mid-run. Not an error: the aborted run left server state untouched. Drop
    // our resume prompt and clear any stale error; the next cycle's reconcile
    // adopts the new owner and re-raises the take-over banner with its data.
    lastSyncError.set(null);
    connectivity.set('online');
    syncStatus.set('idle');
    return 'halt';
  }

  if (resume.status === 'needs-passphrase') {
    // Locked mid-migration: the orchestrator can't finish it unattended. Flag
    // the UI to collect the passphrase; pull/push are gated during a migration
    // anyway, so there's nothing else to do this cycle.
    syncStatus.set('idle');
    return 'halt';
  }

  if (resume.status === 'paused') {
    // Resume ran with the cached key but didn't complete (e.g. a network blip
    // during the push). Surface it; the next trigger retries from where it
    // left off. Still mid-migration, so don't fall through to normal sync.
    const message = resume.result.error ?? 'Encryption migration could not be resumed.';
    lastSyncError.set(message);
    if (looksLikeNetworkError(message) || browserSaysOffline()) {
      connectivity.set('offline');
      syncStatus.set('idle');
    } else {
      connectivity.set('online');
      syncStatus.set('error');
    }
    return 'halt';
  }

  // 'idle' (nothing to resume) or 'resumed' (now in a steady-state mode): let
  // the cycle continue into the normal pull/push.
  return 'continue';
}

export function createSyncOrchestrator(): SyncOrchestrator {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerunQueued = false;
  let disposed = false;
  const idleWaiters = new Set<() => void>();

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
      if (disposed) return;
      if (!userId) {
        syncStatus.set('idle');
        return;
      }

      // Anchor LWW timestamps to the server clock so a device with a skewed wall
      // clock doesn't win (or lose) every cross-device conflict. Best-effort: a
      // failed sample just leaves the last known offset in place.
      const serverMs = await fetchServerTimeMs();
      if (disposed) return;
      if (serverMs !== null) recordServerTime(serverMs);

      // Cloud sync is gated by an active license. If we don't know the state
      // yet, fetch it once. If inactive, skip the cycle entirely — no pull,
      // no push, no connectivity check, no error. The pill renders this as
      // 'no-license' rather than 'error'.
      if (get(licenseActive) === null) {
        try {
          await refreshLicenseActive();
          if (disposed) return;
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
      if (disposed) return;

      // Finish (or hand off) an interrupted migration before steady-state sync.
      // A crash/quit mid-migration leaves this device paused in a `migrating_*`
      // mode; this is what un-sticks it.
      if ((await resumeMigrationIfNeeded()) === 'halt') return;
      if (disposed) return;

      syncStatus.set('syncing');
      // Pull first so local LWW-merges remote state (and reconciles the
      // outbox), then push whatever is genuinely newer locally.
      await pullAndApply();
      if (disposed) return;
      lastPullAt.set(new Date());
      // Setup wizard gates push so a freshly signed-up user can opt into
      // E2EE before any plaintext leaves the device. Pull stays on so the
      // wizard can react to whatever already exists on the account.
      if (!isSetupWizardPending()) {
        const push = await pushOutbox();
        if (disposed) return;
        if (push.skipped === 'mode-rejected') {
          // The server changed sync mode after this cycle reconciled it. The
          // outbox is intentionally intact; rerun immediately so the next
          // reconcile adopts the canonical mode instead of waiting for an
          // unrelated focus/online/edit trigger.
          connectivity.set('online');
          syncStatus.set('idle');
          rerunQueued = true;
          return;
        }
        lastPushAt.set(new Date());
      }
      connectivity.set('online');
      lastSyncError.set(null);
      // A clean cycle *is* a successful sync, even when no rows moved — this is
      // what the "Last synced" indicator reflects. The engine's pull/push only
      // know whether data moved; "a sync happened" is owned here.
      lastSynced.record();
      syncStatus.set('idle');
    } catch (error) {
      const message = errorMessage(error);
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
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
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

  async function dispose(): Promise<void> {
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (!running) return;
    await new Promise<void>((resolve) => idleWaiters.add(resolve));
  }

  return { scheduleSync, syncNow, dispose };
}

// ── App singleton + glue ───────────────────────────────────────────────────

let appOrchestrator: SyncOrchestrator | null = null;
let appTeardown: (() => void) | null = null;

/**
 * Wire the orchestrator into the running app: window focus/online, the
 * outbox-change nudge, and a per-user Realtime subscription that re-targets
 * itself on auth changes. Returns a teardown function (suitable for an
 * `onMount` cleanup).
 */
export function startSyncOrchestrator(): () => void {
  appTeardown?.();
  const orchestrator = createSyncOrchestrator();
  appOrchestrator = orchestrator;

  const trigger = () => orchestrator.scheduleSync();

  // Hydrate the IndexedDB-backed boot state (pull cursor + device id) before the
  // first pull, so a reopen reuses the cursor (no full re-pull) and the device
  // keeps its migration-ownership identity. All sync-triggering paths below wait
  // on this so the first cycle never reads an un-hydrated cursor.
  const booted = deviceEncryptionState.hydrate();

  void booted.then((snapshot) => {
    if (snapshot.hasSessionKey) trigger();
  });

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

  // Realtime only nudges cursor-based sync; transport details stay in the
  // owned remote adapter.
  const stopWatching = remoteSyncLogTransfer.watch(trigger, (signedIn) => {
    // Invalidate the license-active cache on any auth transition so the next
    // sync cycle re-fetches for the new user (or skips entirely if signed out).
    licenseActive.set(null);
    if (!signedIn) return;
    // Catch up on anything missed while this device was away — but only after
    // boot hydration, so this first pull reuses the persisted cursor instead of
    // racing it and re-pulling the whole history.
    void booted.then(() => orchestrator.scheduleSync());
  });

  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', trigger);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    }
    offOutbox();
    stopWatching();
    void orchestrator.dispose();
    if (appOrchestrator === orchestrator) appOrchestrator = null;
    if (appTeardown === teardown) appTeardown = null;
  };
  appTeardown = teardown;
  return teardown;
}

/** Trigger a debounced sync from anywhere in the app (no-op before start). */
export function requestSync(): void {
  appOrchestrator?.scheduleSync();
}

/** Stop background work before Device Data Erasure closes its storage. */
export async function stopSyncOrchestrator(): Promise<void> {
  if (appTeardown) {
    const orchestrator = appOrchestrator;
    appTeardown();
    await orchestrator?.dispose();
    return;
  }
  await appOrchestrator?.dispose();
  appOrchestrator = null;
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

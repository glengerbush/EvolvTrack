<!--
  SyncGate: the single surface that interrupts the app when sync state needs the
  user's attention. It renders one blocking modal at a time:
    - a locked encrypted session (UnlockSessionModal),
    - a migration this device owns (OwnMigrationModal), or
    - a migration running on *another* device (MigrationInProgressModal), which
      shows live progress and offers a take-over.
  Named a "gate" rather than a "banner" because its job is to block, not annotate.
-->
<script lang="ts">
  import { e2eeLifecycle } from '$lib/sync/e2ee-lifecycle-runtime';
  import { requestSync } from '$lib/sync/sync-orchestrator';
  import UnlockSessionModal from '$lib/components/sync/UnlockSessionModal.svelte';
  import MigrationInProgressModal from '$lib/components/sync/MigrationInProgressModal.svelte';
  import OwnMigrationModal from '$lib/components/sync/OwnMigrationModal.svelte';
  import RecoveryCodesModal from '$lib/components/settings/RecoveryCodesModal.svelte';

  // `locked` takes over the whole screen with a non-dismissible unlock modal:
  // a locked session means the DEK is gone, so there's nothing meaningful to
  // show behind it and the user must unlock (or log out) to proceed. This is
  // the steady-state encrypted lock only (gated on syncMode === 'e2ee').
  const forceUnlock = $derived(
    $e2eeLifecycle.syncMode === 'e2ee' && $e2eeLifecycle.status === 'needs-credentials',
  );

  // A migration in flight on *another* device. This device shows progress and
  // offers a take-over (see MigrationInProgressModal).
  const takeover = $derived(
    $e2eeLifecycle.status === 'awaiting-takeover' ? $e2eeLifecycle : null,
  );

  // A migration this device owns — enable, disable, or key rotation. While it
  // is in flight we block the app with a non-dismissible modal (see
  // OwnMigrationModal): migrations are multi-step server operations, and letting
  // the user keep editing or toggling mid-flight is what used to wedge them.
  // Covers running, paused-with-error, and "needs the passphrase to resume".
  const ownMigration = $derived(
    $e2eeLifecycle.syncMode !== 'plain' &&
      $e2eeLifecycle.syncMode !== 'e2ee' &&
      $e2eeLifecycle.ownership === 'self',
  );
  const ownMigrationDirection = $derived($e2eeLifecycle.direction ?? 'enable');

  const visible = $derived.by(() => {
    // A foreign-device migration wins: this device can only wait / take over,
    // it can't drive it, so don't also pop the own-migration modal.
    if (takeover) return 'takeover-modal' as const;
    if (ownMigration) return 'own-migration' as const;
    if (forceUnlock) return 'locked' as const;
    return null;
  });

  const percent = $derived.by(() => {
    const t = takeover?.recordsTotal;
    const c = takeover?.recordsConverted;
    if (!t || t <= 0 || c == null) return null;
    return Math.min(100, Math.round((c / t) * 100));
  });

  const stale = $derived($e2eeLifecycle.allowedActions.includes('take-over'));

  let takingOver = $state(false);
  let takeoverError = $state<string | null>(null);
  const recoveryNeedsAttention = $derived(
    $e2eeLifecycle.syncMode === 'e2ee' && $e2eeLifecycle.recoveryAttention,
  );
  let newRecoveryCode = $state<string | null>(null);
  let recoveryBusy = $state(false);
  let recoveryError = $state('');

  $effect(() => {
    void e2eeLifecycle.refresh();
  });

  $effect(() => {
    if ($e2eeLifecycle.syncMode !== 'e2ee') return;
    const timer = setInterval(() => void e2eeLifecycle.refresh(), 30_000);
    return () => clearInterval(timer);
  });

  async function generateRecoveryCode() {
    recoveryBusy = true;
    recoveryError = '';
    try {
      newRecoveryCode = await e2eeLifecycle.generateRecoveryCode();
    } catch (cause) {
      recoveryError = (cause as Error).message;
    } finally {
      recoveryBusy = false;
    }
  }

  async function acknowledgeRecoveryCode() {
    await e2eeLifecycle.acknowledgeRecoveryCode();
    newRecoveryCode = null;
  }

  async function continueWithoutRecoveryCode() {
    await e2eeLifecycle.continueWithoutRecoveryCode();
    newRecoveryCode = null;
  }

  async function continueWithoutFromBanner() {
    recoveryBusy = true;
    recoveryError = '';
    try {
      await continueWithoutRecoveryCode();
    } catch (cause) {
      recoveryError = (cause as Error).message;
    } finally {
      recoveryBusy = false;
    }
  }

  async function takeOver() {
    if (takingOver) return;
    takingOver = true;
    takeoverError = null;
    try {
      await e2eeLifecycle.takeOver();
      // This device now owns the migration. Nudge a sync; the orchestrator's
      // auto-resume then asks for the passphrase (forced unlock modal) and
      // drives the migration to completion.
      requestSync();
    } catch (cause) {
      takeoverError = (cause as Error).message ?? 'Could not take over the migration.';
    } finally {
      takingOver = false;
    }
  }

  // While a foreign migration is in flight, poll the server for live progress
  // and heartbeat freshness. (The owner heartbeats `sync_accounts` every
  // ~MIGRATION_HEARTBEAT_MS during the backfill, so Supabase Realtime would
  // also work here; we poll instead to keep this cold, rarely-hit path free of
  // a persistent subscription.) Refreshes the shared store so the modal stays
  // current.
  async function pollProgress() {
    try {
      const snapshot = await e2eeLifecycle.refresh();
      if (snapshot.status !== 'awaiting-takeover') {
        // Migration finished, vanished, or this device now owns it. Let the
        // orchestrator's next cycle reconcile/resume.
        requestSync();
      }
    } catch {
      // Transient (offline / auth blip): keep the last-known progress.
    }
  }

  // Depend only on *whether* a take-over is active, not its contents — polling
  // mutates the store each tick, and reading the object here would re-run the
  // effect (tearing down and recreating the loop) on every tick.
  const takeoverActive = $derived($e2eeLifecycle.status === 'awaiting-takeover');

  // Poll fast while the owner is actively heartbeating; back off once it looks
  // stalled (no heartbeat for MIGRATION_OWNER_STALE_MS). Without this, a tab left open
  // on a stuck migration would hit `sync_accounts` every few seconds forever. A
  // fresh heartbeat snaps the cadence back to fast on the next tick.
  const FRESH_POLL_MS = 3000;
  const STALE_POLL_MS = 15000;

  $effect(() => {
    if (!takeoverActive) {
      takeoverError = null;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    // Self-scheduling timeout (not setInterval) so the next delay can adapt to
    // staleness, and so a slow poll can never overlap the next one. `stale` is
    // read after the await, so it isn't tracked as an effect dependency — the
    // loop is owned solely by `takeoverActive`.
    const tick = async () => {
      await pollProgress();
      if (cancelled) return;
      timer = setTimeout(tick, stale ? STALE_POLL_MS : FRESH_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  });
</script>

<svelte:window onfocus={() => void e2eeLifecycle.refresh()} />

{#if visible === 'own-migration'}
  <OwnMigrationModal
    direction={ownMigrationDirection}
    converted={$e2eeLifecycle.recordsConverted}
    total={$e2eeLifecycle.recordsTotal}
    percent={$e2eeLifecycle.recordsTotal
      ? Math.min(100, Math.round((($e2eeLifecycle.recordsConverted ?? 0) / $e2eeLifecycle.recordsTotal) * 100))
      : null}
    error={$e2eeLifecycle.error ?? null}
    awaitingPassphrase={$e2eeLifecycle.status === 'needs-credentials'}
  />
{:else if visible === 'locked'}
  <UnlockSessionModal dismissible={false} onClose={() => {}} />
{:else if visible === 'takeover-modal' && takeover}
  <MigrationInProgressModal
    direction={takeover.direction ?? 'enable'}
    converted={takeover.recordsConverted}
    total={takeover.recordsTotal}
    {percent}
    {stale}
    {takingOver}
    error={takeoverError}
    onTakeOver={takeOver}
  />
{/if}

{#if visible === null && recoveryNeedsAttention && !newRecoveryCode}
  <aside class="recovery-banner" aria-labelledby="recovery-banner-title">
    <div>
      <strong id="recovery-banner-title">Your recovery code was not confirmed</strong>
      <p>Generate a replacement, or continue without one.</p>
      {#if recoveryError}<p class="recovery-error" role="alert">{recoveryError}</p>{/if}
    </div>
    <div class="recovery-actions">
      {#if $e2eeLifecycle.allowedActions.includes('continue-without-recovery')}
        <button type="button" disabled={recoveryBusy} onclick={continueWithoutFromBanner}>
          Continue without
        </button>
      {/if}
      {#if $e2eeLifecycle.allowedActions.includes('generate-recovery')}
        <button class="primary" type="button" disabled={recoveryBusy} onclick={generateRecoveryCode}>
          {recoveryBusy ? 'Generating…' : 'Generate replacement'}
        </button>
      {/if}
    </div>
  </aside>
{/if}

{#if newRecoveryCode}
  <RecoveryCodesModal
    code={newRecoveryCode}
    onDone={acknowledgeRecoveryCode}
    onContinueWithout={continueWithoutRecoveryCode}
  />
{/if}

<style>
  .recovery-banner {
    position: fixed;
    top: 1rem;
    left: 50%;
    translate: -50% 0;
    z-index: 900;
    width: min(44rem, calc(100% - 2rem));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.85rem 1rem;
    border: 1px solid color-mix(in oklab, var(--brand, #1f7a3a) 35%, transparent);
    border-radius: var(--radius-md, 12px);
    background: var(--surface, #fff);
    color: var(--text, #111);
    box-shadow: var(--shadow-soft, 0 8px 24px rgba(0, 0, 0, 0.2));
  }

  .recovery-banner p { margin: 0.2rem 0 0; }
  .recovery-error { color: var(--danger, #b42318); }
  .recovery-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
  .recovery-actions button {
    font: inherit;
    padding: 0.45rem 0.8rem;
    border: 1px solid color-mix(in oklab, var(--text, #111) 18%, transparent);
    border-radius: 999px;
    background: var(--surface, #fff);
    color: var(--text, #111);
    cursor: pointer;
  }
  .recovery-actions .primary {
    border-color: var(--brand, #1f7a3a);
    background: var(--brand, #1f7a3a);
    color: #fff;
  }

  @media (max-width: 600px) {
    .recovery-banner { align-items: stretch; flex-direction: column; }
    .recovery-actions { justify-content: flex-end; }
  }
</style>

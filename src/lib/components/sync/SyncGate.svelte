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
  import { syncIndicator } from '$lib/stores/syncIndicator';
  import { migrationResumePending, migrationTakeoverAvailable } from '$lib/stores/syncStore';
  import { MIGRATION_STALE_MS, takeOverMigration } from '$lib/sync/e2ee-migration';
  import { fetchRemoteSyncAccount, getDeviceId } from '$lib/sync/account-state';
  import { requestSync } from '$lib/sync/sync-orchestrator';
  import UnlockSessionModal from '$lib/components/sync/UnlockSessionModal.svelte';
  import MigrationInProgressModal from '$lib/components/sync/MigrationInProgressModal.svelte';
  import OwnMigrationModal from '$lib/components/sync/OwnMigrationModal.svelte';

  // `locked` takes over the whole screen with a non-dismissible unlock modal:
  // a locked session means the DEK is gone, so there's nothing meaningful to
  // show behind it and the user must unlock (or log out) to proceed. This is
  // the steady-state encrypted lock only (gated on syncMode === 'e2ee').
  const forceUnlock = $derived($syncIndicator.kind === 'locked');

  // A migration in flight on *another* device. This device shows progress and
  // offers a take-over (see MigrationInProgressModal).
  const takeover = $derived($migrationTakeoverAvailable);

  // A migration this device owns — enable, disable, or key rotation. While it
  // is in flight we block the app with a non-dismissible modal (see
  // OwnMigrationModal): migrations are multi-step server operations, and letting
  // the user keep editing or toggling mid-flight is what used to wedge them.
  // Covers running, paused-with-error, and "needs the passphrase to resume".
  const ownMigration = $derived(
    $syncIndicator.kind === 'migrating' ||
      $syncIndicator.kind === 'migration-paused' ||
      $migrationResumePending !== null,
  );
  const ownMigrationDirection = $derived(
    $syncIndicator.migration?.direction ?? $migrationResumePending ?? 'enable',
  );

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

  // A ticking clock so staleness re-evaluates between polls.
  let now = $state(Date.now());
  const stale = $derived.by(() => {
    const ts = takeover?.updatedAt;
    if (!ts) return false;
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) && now - parsed > MIGRATION_STALE_MS;
  });

  let takingOver = $state(false);
  let takeoverError = $state<string | null>(null);

  async function takeOver() {
    if (takingOver) return;
    takingOver = true;
    takeoverError = null;
    try {
      await takeOverMigration();
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
    now = Date.now();
    try {
      const account = await fetchRemoteSyncAccount();
      const m = account?.migration;
      const migrating =
        account?.syncMode === 'migrating_to_e2ee' ||
        account?.syncMode === 'migrating_to_plain' ||
        account?.syncMode === 'rotating_e2ee_key';
      if (!account || !migrating || !m || m.ownerDeviceId === getDeviceId()) {
        // Migration finished, vanished, or this device now owns it. Drop the
        // offer and let the orchestrator's next cycle reconcile/resume.
        migrationTakeoverAvailable.set(null);
        requestSync();
        return;
      }
      migrationTakeoverAvailable.set({
        direction: (m.direction ?? 'enable') as 'enable' | 'disable' | 'rotate',
        ownerDeviceId: m.ownerDeviceId,
        recordsConverted: m.recordsConverted,
        recordsTotal: m.recordsTotal,
        updatedAt: m.updatedAt,
      });
    } catch {
      // Transient (offline / auth blip): keep the last-known progress.
    }
  }

  // Depend only on *whether* a take-over is active, not its contents — polling
  // mutates the store each tick, and reading the object here would re-run the
  // effect (tearing down and recreating the loop) on every tick.
  const takeoverActive = $derived($migrationTakeoverAvailable !== null);

  // Poll fast while the owner is actively heartbeating; back off once it looks
  // stalled (no heartbeat for MIGRATION_STALE_MS). Without this, a tab left open
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

{#if visible === 'own-migration'}
  <OwnMigrationModal
    direction={ownMigrationDirection}
    converted={$syncIndicator.migration?.recordsConverted}
    total={$syncIndicator.migration?.recordsTotal}
    percent={$syncIndicator.migration?.percent ?? null}
    error={$syncIndicator.migration?.error ?? null}
    awaitingPassphrase={$migrationResumePending !== null}
  />
{:else if visible === 'locked'}
  <UnlockSessionModal dismissible={false} onClose={() => {}} />
{:else if visible === 'takeover-modal' && takeover}
  <MigrationInProgressModal
    direction={takeover.direction}
    converted={takeover.recordsConverted}
    total={takeover.recordsTotal}
    {percent}
    {stale}
    {takingOver}
    error={takeoverError}
    onTakeOver={takeOver}
  />
{/if}

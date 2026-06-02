<script lang="ts">
  import { resolve } from '$app/paths';
  import { syncIndicator } from '$lib/stores/syncIndicator';
  import { migrationResumePending, migrationTakeoverAvailable } from '$lib/stores/syncStore';
  import { MIGRATION_STALE_MS, takeOverMigration } from '$lib/sync/e2ee-migration';
  import { fetchRemoteSyncAccount, getDeviceId } from '$lib/sync/account-state';
  import { requestSync } from '$lib/sync/sync-orchestrator';
  import UnlockSessionModal from '$lib/components/sync/UnlockSessionModal.svelte';
  import MigrationInProgressModal from '$lib/components/sync/MigrationInProgressModal.svelte';

  // `locked` takes over the whole screen with a non-dismissible unlock modal:
  // a locked session means the DEK is gone, so there's nothing meaningful to
  // show behind it and the user must unlock (or log out) to proceed.
  //
  // `migrationResumePending` is the same situation *during a migration*: the
  // orchestrator can't auto-finish it because the session key is gone. The
  // `locked` indicator never fires mid-migration (it's gated on syncMode ===
  // 'e2ee'), so we force the same unlock modal here. Entering the passphrase
  // caches the DEK and nudges a sync, and the orchestrator's auto-resume then
  // drives the stuck migration to completion.
  //
  // `migration-paused` (a migration that hit a *retriable* error, e.g. a
  // network blip, while the key was available) stays a soft banner — the rest
  // of the app is usable and it retries on its own.
  const forceUnlock = $derived($syncIndicator.kind === 'locked' || $migrationResumePending !== null);

  // A migration in flight on *another* device. This device shows progress and
  // offers a take-over (see MigrationInProgressModal). Lower priority than the
  // forced unlock modal, higher than the soft paused banner.
  const takeover = $derived($migrationTakeoverAvailable);

  // The user can collapse the modal to a thin banner ("keep waiting"); the
  // banner still shows live progress as an ongoing cue. Reset whenever the
  // take-over offer goes away (migration finished, or this device took over).
  let takeoverDismissed = $state(false);

  const visible = $derived.by(() => {
    if (forceUnlock) return 'locked' as const;
    if (takeover) return takeoverDismissed ? ('takeover-banner' as const) : ('takeover-modal' as const);
    if ($syncIndicator.kind === 'migration-paused') return 'migration-paused' as const;
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
  // and heartbeat freshness (the owning device pushes encrypted rows only at
  // the end, so Realtime wouldn't nudge us during the backfill). Refreshes the
  // shared store so both the modal and the collapsed banner stay current.
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
  // mutates the store every 3s, and reading the object here would re-run the
  // effect (tearing down and recreating the interval) on every tick.
  const takeoverActive = $derived($migrationTakeoverAvailable !== null);

  $effect(() => {
    if (!takeoverActive) {
      takeoverDismissed = false;
      takeoverError = null;
      return;
    }
    void pollProgress();
    const id = setInterval(() => void pollProgress(), 3000);
    return () => clearInterval(id);
  });

  const settingsHref = resolve('/app') + '#settings';
</script>

{#if visible === 'locked'}
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
    onKeepWaiting={() => (takeoverDismissed = true)}
    onTakeOver={takeOver}
  />
{:else if visible === 'takeover-banner' && takeover}
  <div class="banner" role="status" data-tone="warn">
    <div class="text">
      <strong>
        {stale ? 'Encryption setup may have stalled' : 'Encryption setup in progress on another device'}
      </strong>
      <span>
        {takeoverError
          ? takeoverError
          : percent != null
            ? `${percent}% complete${stale ? ' — no recent progress.' : '.'}`
            : stale
              ? 'No recent progress from the other device.'
              : 'Finishing on another device…'}
      </span>
    </div>
    <button class="cta" type="button" onclick={() => (takeoverDismissed = false)}>Details</button>
  </div>
{:else if visible === 'migration-paused'}
  <div class="banner" role="alert" data-tone="warn">
    <div class="text">
      <strong>Encryption migration is paused.</strong>
      <span>
        {$syncIndicator.migration?.error
          ? `Last error: ${$syncIndicator.migration.error}`
          : 'Enter your passphrase to resume.'}
      </span>
    </div>
    <a class="cta" href={settingsHref}>Resume</a>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.9rem;
    background: color-mix(in oklab, var(--warning, #e08a3c) 14%, var(--surface, #fff));
    border-bottom: 1px solid color-mix(in oklab, var(--warning, #e08a3c) 35%, transparent);
    font-size: 0.85rem;
    line-height: 1.3;
  }
  .text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .text strong { font-weight: 700; }
  .text span { color: color-mix(in oklab, currentColor 75%, transparent); }
  .cta {
    flex-shrink: 0;
    padding: 0.3rem 0.75rem;
    border: 1px solid color-mix(in oklab, currentColor 35%, transparent);
    border-radius: 8px;
    background: var(--surface, #fff);
    font: inherit;
    font-weight: 600;
    text-decoration: none;
    color: inherit;
    cursor: pointer;
  }
  .cta:hover { background: color-mix(in oklab, currentColor 6%, var(--surface, #fff)); }
  .cta:disabled { opacity: 0.6; cursor: not-allowed; }
</style>

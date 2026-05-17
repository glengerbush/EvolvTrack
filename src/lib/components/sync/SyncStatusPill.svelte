<script lang="ts">
  import { onMount } from 'svelte';
  import { syncIndicator } from '$lib/stores/syncIndicator';
  import { formatRelativeTime } from '$lib/stores/syncStore';
  import { syncNow } from '$lib/sync/sync-orchestrator';

  let open = $state(false);
  let pillEl: HTMLButtonElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();
  let busy = $state(false);
  // Re-render the relative timestamps every 30s so "2 min ago" stays honest
  // without subscribing every consumer to a per-second tick.
  let nowTick = $state(Date.now());

  onMount(() => {
    const interval = window.setInterval(() => (nowTick = Date.now()), 30_000);
    return () => window.clearInterval(interval);
  });

  function onDocClick(event: MouseEvent) {
    if (!open) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (pillEl?.contains(target) || popoverEl?.contains(target)) return;
    open = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      open = false;
      pillEl?.focus();
    }
  }

  async function manualSync() {
    busy = true;
    try {
      await syncNow();
    } finally {
      busy = false;
    }
  }

  const tone = $derived($syncIndicator.tone);
  const indicator = $derived($syncIndicator);
  const lastSyncedRel = $derived(
    indicator.lastSynced
      ? formatRelativeTime(indicator.lastSynced, new Date(nowTick))
      : null,
  );
  const userEmail = $derived(
    indicator.user.kind === 'signed-in' ? indicator.user.user.email ?? null : null,
  );
  const encryptionLabel = $derived(
    indicator.encryption === 'e2ee'
      ? 'On'
      : indicator.encryption === 'migrating-enable'
      ? 'Turning on…'
      : indicator.encryption === 'migrating-disable'
      ? 'Turning off…'
      : 'Off',
  );
  const canSync = $derived(
    indicator.kind !== 'signed-out' &&
      indicator.kind !== 'signed-out-expired' &&
      indicator.kind !== 'syncing' &&
      indicator.kind !== 'migrating',
  );
</script>

<svelte:window on:keydown={onKeydown} on:click={onDocClick} />

<div class="wrap">
  <button
    type="button"
    bind:this={pillEl}
    class="pill"
    data-tone={tone}
    data-kind={indicator.kind}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Sync status: {indicator.label}"
    onclick={() => (open = !open)}
  >
    <span class="dot" aria-hidden="true"></span>
    <span class="label">{indicator.label}</span>
  </button>

  {#if open}
    <div bind:this={popoverEl} class="popover" role="dialog" aria-label="Sync details">
      <header class="head" data-tone={tone}>
        <strong>{indicator.label}</strong>
        <p>{indicator.description}</p>
      </header>

      <dl class="grid">
        <dt>Account</dt>
        <dd>{userEmail ?? 'Not signed in'}</dd>

        <dt>Encryption</dt>
        <dd>{encryptionLabel}</dd>

        {#if indicator.encryption === 'e2ee'}
          <dt>Session</dt>
          <dd>{indicator.kind === 'locked' ? 'Locked' : 'Unlocked for this session'}</dd>
        {/if}

        <dt>Connectivity</dt>
        <dd class="cap">{indicator.connectivity}</dd>

        <dt>Pending</dt>
        <dd>
          {indicator.pendingChanges === 0
            ? 'None'
            : `${indicator.pendingChanges} change${indicator.pendingChanges === 1 ? '' : 's'}`}
        </dd>

        <dt>Last synced</dt>
        <dd>{lastSyncedRel ?? 'Never'}</dd>

        {#if indicator.migration}
          <dt>Migration</dt>
          <dd>
            {indicator.migration.direction === 'enable' ? 'Enabling E2EE' : 'Disabling E2EE'}
            {#if indicator.migration.encryptedCount !== undefined}
              · {indicator.migration.encryptedCount} encrypted
            {/if}
            {#if indicator.migration.plaintextCount !== undefined}
              · {indicator.migration.plaintextCount} plaintext
            {/if}
          </dd>
        {/if}

        {#if indicator.lastError}
          <dt>Last error</dt>
          <dd class="error">{indicator.lastError}</dd>
        {/if}
      </dl>

      <footer class="actions">
        <button
          type="button"
          class="sync-btn"
          onclick={manualSync}
          disabled={!canSync || busy}
        >
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      </footer>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.7rem 0.25rem 0.55rem;
    border: 1px solid color-mix(in oklab, currentColor 15%, transparent);
    border-radius: 999px;
    background: color-mix(in oklab, var(--surface, #fff) 90%, transparent);
    font-size: 0.78rem;
    font-weight: 600;
    color: inherit;
    cursor: pointer;
    line-height: 1;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .pill:hover { background: color-mix(in oklab, currentColor 6%, var(--surface, #fff)); }
  .pill:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--dot-color, #9aa0a6);
    box-shadow: 0 0 0 0 color-mix(in oklab, var(--dot-color, #9aa0a6) 60%, transparent);
  }

  .pill[data-tone='good']     { --dot-color: var(--success, #2e9c5b); }
  .pill[data-tone='progress'] { --dot-color: var(--accent, #f0a14b); }
  .pill[data-tone='warn']     { --dot-color: var(--warning, #e08a3c); }
  .pill[data-tone='bad']      { --dot-color: var(--danger, #d4524f); }
  .pill[data-tone='neutral']  { --dot-color: #9aa0a6; }

  .pill[data-tone='progress'] .dot {
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--dot-color) 50%, transparent); }
    50%      { box-shadow: 0 0 0 6px color-mix(in oklab, var(--dot-color) 0%, transparent); }
  }

  .label { white-space: nowrap; }

  .popover {
    position: absolute;
    top: calc(100% + 0.45rem);
    right: 0;
    width: min(320px, calc(100vw - 2rem));
    background: var(--surface, #fff);
    border: 1px solid color-mix(in oklab, currentColor 12%, transparent);
    border-radius: 12px;
    box-shadow: 0 14px 36px -10px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.06);
    padding: 0.85rem 0.95rem 0.85rem;
    z-index: 10;
    font-size: 0.85rem;
  }

  .head { margin-bottom: 0.7rem; }
  .head strong { font-size: 0.95rem; }
  .head p { margin: 0.2rem 0 0; color: color-mix(in oklab, currentColor 70%, transparent); font-size: 0.8rem; line-height: 1.35; }

  .grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.9rem;
    row-gap: 0.3rem;
    margin: 0 0 0.8rem;
  }
  .grid dt { color: color-mix(in oklab, currentColor 55%, transparent); font-weight: 500; }
  .grid dd { margin: 0; word-break: break-word; }
  .grid dd.cap { text-transform: capitalize; }
  .grid dd.error { color: var(--danger, #b3413f); }

  .actions { display: flex; justify-content: flex-end; }
  .sync-btn {
    padding: 0.35rem 0.85rem;
    border: 1px solid color-mix(in oklab, currentColor 25%, transparent);
    background: transparent;
    border-radius: 8px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .sync-btn:disabled { opacity: 0.5; cursor: default; }
  .sync-btn:hover:not(:disabled) { background: color-mix(in oklab, currentColor 6%, transparent); }
</style>

<script lang="ts">
  import { resolve } from '$app/paths';
  import { syncIndicator } from '$lib/stores/syncIndicator';
  import { expiredBannerDismissed } from '$lib/stores/authStore';
  import UnlockSessionModal from '$lib/components/sync/UnlockSessionModal.svelte';

  // Only the three states that require user action surface here. Everything
  // else (offline, error, pending) lives in the pill — banners interrupt and
  // we don't want to interrupt for self-healing states.
  const visible = $derived.by(() => {
    const ind = $syncIndicator;
    if (ind.kind === 'locked') return 'locked' as const;
    if (ind.kind === 'migration-paused') return 'migration-paused' as const;
    if (ind.kind === 'signed-out-expired' && !$expiredBannerDismissed) return 'expired' as const;
    return null;
  });

  const settingsHref = resolve('/app') + '#settings';
  let unlockOpen = $state(false);
</script>

{#if visible === 'locked'}
  <div class="banner" role="alert" data-tone="warn">
    <div class="text">
      <strong>Sync is paused — session locked.</strong>
      <span>Enter your passphrase to resume encrypted sync.</span>
    </div>
    <button type="button" class="cta" onclick={() => (unlockOpen = true)}>Unlock</button>
  </div>
  {#if unlockOpen}
    <UnlockSessionModal onClose={() => (unlockOpen = false)} />
  {/if}
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
{:else if visible === 'expired'}
  <div class="banner" role="alert" data-tone="warn">
    <div class="text">
      <strong>Your session has expired.</strong>
      <span>Sign in again to resume syncing across devices.</span>
    </div>
    <a class="cta" href={settingsHref}>Sign in</a>
    <button
      type="button"
      class="dismiss"
      aria-label="Dismiss"
      onclick={() => expiredBannerDismissed.dismiss()}
    >×</button>
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
  .dismiss {
    flex-shrink: 0;
    border: none;
    background: transparent;
    font-size: 1.2rem;
    line-height: 1;
    color: inherit;
    cursor: pointer;
    padding: 0 0.3rem;
    opacity: 0.6;
  }
  .dismiss:hover { opacity: 1; }
</style>

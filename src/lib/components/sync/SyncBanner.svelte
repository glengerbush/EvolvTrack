<script lang="ts">
  import { resolve } from '$app/paths';
  import { syncIndicator } from '$lib/stores/syncIndicator';
  import UnlockSessionModal from '$lib/components/sync/UnlockSessionModal.svelte';

  // `locked` takes over the whole screen with a non-dismissible unlock modal:
  // a locked session means the DEK is gone, so there's nothing meaningful to
  // show behind it and the user must unlock (or log out) to proceed.
  // `migration-paused` stays a soft banner — it's recoverable from Settings
  // and the rest of the app is still usable. `signed-out-expired` used to
  // render here, but the root layout now redirects to /auth on that state so
  // the user lands on the actual sign-in form instead of a banner CTA.
  const visible = $derived.by(() => {
    const ind = $syncIndicator;
    if (ind.kind === 'locked') return 'locked' as const;
    if (ind.kind === 'migration-paused') return 'migration-paused' as const;
    return null;
  });

  const settingsHref = resolve('/app') + '#settings';
</script>

{#if visible === 'locked'}
  <UnlockSessionModal dismissible={false} onClose={() => {}} />
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
</style>

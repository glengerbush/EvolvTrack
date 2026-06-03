<script lang="ts">
  import {
    storageHealth,
    storageWarningDismissed,
    dismissStorageWarning,
    storageBannerKind,
  } from '$lib/stores/storageHealth';

  // Warns when the browser can't durably keep this app's data — either
  // IndexedDB is blocked outright, or storage isn't persistent (typically a
  // "delete site data when the browser closes" setting). Offline-first apps
  // silently lose everything otherwise, which is baffling to the user.
  const kind = $derived(storageBannerKind($storageHealth, $storageWarningDismissed));
</script>

{#if kind}
  <div class="storage-banner" role="alert" data-kind={kind}>
    <div class="text">
      {#if kind === 'unavailable'}
        <strong>This browser is blocking local storage.</strong>
        <span>
          EvolvTrack can't save your weigh-ins, doses, or sign-in here. This is
          usually a private/incognito window or a strict privacy setting — try a
          normal window, or let this site store data.
        </span>
      {:else}
        <strong>This browser may not keep your data between sessions.</strong>
        <span>
          If your entries disappear after you close the app, your browser is
          clearing site data on exit. Turn that off so EvolvTrack keeps your data
          and encryption session — on Firefox/IronFox for Android it's
          Settings → Delete browsing data on quit.
        </span>
      {/if}
    </div>
    <button
      class="dismiss"
      type="button"
      aria-label="Dismiss storage warning"
      title="Dismiss"
      onclick={dismissStorageWarning}
    >×</button>
  </div>
{/if}

<style>
  .storage-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.9rem;
    background: color-mix(in oklab, var(--warning, #e08a3c) 16%, var(--surface, #fff));
    border-bottom: 1px solid color-mix(in oklab, var(--warning, #e08a3c) 38%, transparent);
    font-size: 0.85rem;
    line-height: 1.3;
  }
  /* IndexedDB fully blocked is more severe than merely non-persistent. */
  .storage-banner[data-kind='unavailable'] {
    background: color-mix(in oklab, var(--danger, #b91c1c) 14%, var(--surface, #fff));
    border-bottom-color: color-mix(in oklab, var(--danger, #b91c1c) 40%, transparent);
  }
  .text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .text strong { font-weight: 700; }
  .text span { color: color-mix(in oklab, currentColor 78%, transparent); }
  .dismiss {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
  }
  .dismiss:hover,
  .dismiss:focus-visible {
    background: color-mix(in oklab, currentColor 12%, transparent);
  }
</style>

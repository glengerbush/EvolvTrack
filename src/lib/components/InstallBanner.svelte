<script lang="ts">
  import { canInstall, installDismissed, promptInstall, dismissInstallBanner } from '$lib/stores/pwaInstallStore';

  // Shown app-wide only where the browser offers a native install prompt
  // (Chromium desktop + Android) and the user hasn't dismissed it. Elsewhere
  // it never appears and the per-device FAQ steps apply.
  const visible = $derived($canInstall && !$installDismissed);
</script>

{#if visible}
  <div class="install-banner" role="region" aria-label="Install EvolvTrack">
    <div class="text">
      <strong>Install EvolvTrack</strong>
      <span>Add it to your device for offline access and an app-like experience.</span>
    </div>
    <button class="cta" type="button" onclick={() => promptInstall()}>Install</button>
    <button
      class="dismiss"
      type="button"
      aria-label="Dismiss install banner"
      title="Dismiss"
      onclick={dismissInstallBanner}
    >×</button>
  </div>
{/if}

<style>
  /* App-wide info banner, tinted with the brand accent. */
  .install-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.9rem;
    background: color-mix(in oklab, var(--brand, #3c7de0) 12%, var(--surface, #fff));
    border-bottom: 1px solid color-mix(in oklab, var(--brand, #3c7de0) 35%, transparent);
    font-size: 0.85rem;
    line-height: 1.3;
  }
  .text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .text strong { font-weight: 700; }
  .text span { color: color-mix(in oklab, currentColor 75%, transparent); }
  .cta {
    flex-shrink: 0;
    padding: 0.3rem 0.85rem;
    border: 0;
    border-radius: 999px;
    background: var(--brand, #3c7de0);
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .cta:hover { opacity: 0.92; }
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

<script lang="ts">
  import DismissButton from '$lib/components/DismissButton.svelte';
  import DosageCalculator from '$lib/components/dashboard/calculators/DosageCalculator.svelte';
  import ReverseDoseCalculator from '$lib/components/dashboard/calculators/ReverseDoseCalculator.svelte';
  import VialTransitionCalculator from '$lib/components/dashboard/calculators/VialTransitionCalculator.svelte';
  import SplitDoseCalculator from '$lib/components/dashboard/calculators/SplitDoseCalculator.svelte';

  const {} = $props();

  const BANNER_STORAGE_KEY = 'evolvtrack-calculator-syringe-banner-dismissed';

  // Default to hidden during SSR / before the localStorage read so the banner
  // never flashes for a returning user who already dismissed it.
  let bannerVisible = $state(false);

  $effect(() => {
    if (typeof window === 'undefined') return;
    bannerVisible = localStorage.getItem(BANNER_STORAGE_KEY) !== 'true';
  });

  function dismissBanner() {
    bannerVisible = false;
    if (typeof window !== 'undefined') {
      localStorage.setItem(BANNER_STORAGE_KEY, 'true');
    }
  }
</script>

<main class="content">
  {#if bannerVisible}
    <aside class="syringe-banner" role="note">
      <span class="syringe-banner-icon" aria-hidden="true">ⓘ</span>
      <p>
        These calculators assume a standard <strong>U-100 insulin syringe</strong>
        (100 units = 1 mL). If your syringe uses a different scale, convert the
        result before drawing.
      </p>
      <DismissButton ariaLabel="Dismiss this notice" onclick={dismissBanner} />
    </aside>
  {/if}

  <DosageCalculator />
  <ReverseDoseCalculator />
  <SplitDoseCalculator />
  <VialTransitionCalculator />
</main>

<style>
  .content {
    width: min(100% - 2rem, 1240px);
    margin-inline: auto;
    padding: 1rem 0 1.25rem;
    display: grid;
    gap: 1rem;
    align-content: start;
  }

  .syringe-banner {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.6rem;
    padding: 0.7rem 0.9rem;
    background: color-mix(in oklab, var(--accent, var(--headerBg)) 18%, var(--surface) 82%);
    border: 1px solid color-mix(in oklab, var(--accent, var(--headerBg)) 35%, transparent);
    border-radius: 10px;
    color: var(--text);
    font-size: 0.92rem;
    line-height: 1.4;
  }
  .syringe-banner p {
    margin: 0;
  }
  .syringe-banner-icon {
    font-size: 1.1rem;
    line-height: 1.4;
    color: var(--muted);
  }
</style>

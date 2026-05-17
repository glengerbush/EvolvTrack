<script lang="ts">
  import DosageCalculator from '$lib/components/dashboard/calculators/DosageCalculator.svelte';
  import ReverseDoseCalculator from '$lib/components/dashboard/calculators/ReverseDoseCalculator.svelte';
  import VialTransitionCalculator from '$lib/components/dashboard/calculators/VialTransitionCalculator.svelte';
  const {} = $props();
</script>

<main class="content">
  <DosageCalculator />
  <ReverseDoseCalculator />
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
</style>

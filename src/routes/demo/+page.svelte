<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { isDemoMode } from '$lib/stores/demoStore';
  import { awaitSettledAuth } from '$lib/stores/authStore';
  import { getAllEntries, getAllPrescriptions } from '$lib/domain/repo';

  // Dedicated, shareable demo entry point. Enabling demo mode reseeds the local
  // DB (seedDemoData clears it first), so unlike the in-page button this URL can
  // be hit by someone who already has real data — we confirm before wiping it.
  let cancelled = $state(false);

  async function hasDataToLose(): Promise<boolean> {
    // Demo data is disposable — reseeding over an existing demo is fine.
    if (get(isDemoMode)) return false;
    // A real synced account always has data worth protecting.
    if ((await awaitSettledAuth()).kind === 'signed-in') return true;
    // Signed-out: only local-only data is at risk.
    const [entries, prescriptions] = await Promise.all([getAllEntries(), getAllPrescriptions()]);
    return entries.length > 0 || prescriptions.length > 0;
  }

  onMount(() => {
    let active = true;
    void (async () => {
      if (await hasDataToLose()) {
        const ok = confirm(
          'Loading the demo replaces the data currently stored in this browser with sample data. Continue?',
        );
        if (!ok) {
          if (active) cancelled = true;
          return;
        }
      }
      await isDemoMode.enable();
      // Replace, not push: keeps this redirector out of the history stack so
      // a back-navigation from /app lands on whatever preceded /demo (usually
      // the homepage) instead of bouncing straight back through here.
      if (active) await goto('/app', { replaceState: true });
    })();
    return () => {
      active = false;
    };
  });
</script>

<svelte:head>
  <title>Demo · EvolvTrack</title>
</svelte:head>

<div class="demo-gate">
  {#if cancelled}
    <p class="demo-msg">Demo cancelled — your data is untouched.</p>
    <nav class="demo-actions">
      <a class="btn btn-primary" href="/app">Go to the app</a>
      <a class="btn btn-ghost" href="/">Back home</a>
    </nav>
  {:else}
    <p class="demo-msg" role="status">Loading the demo…</p>
  {/if}
</div>

<style>
  .demo-gate {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }
  .demo-msg {
    margin: 0;
    font-size: 1.05rem;
    color: var(--text);
  }
  .demo-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>

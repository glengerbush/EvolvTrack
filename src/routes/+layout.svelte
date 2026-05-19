<script lang="ts">
  import '$lib/styles/global.css';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { registerServiceWorker } from '$lib/utils/pwa';
  import { startSyncOrchestrator } from '$lib/sync/sync-orchestrator';
  import SyncBanner from '$lib/components/sync/SyncBanner.svelte';
  import { activeColorMode } from '$lib/stores/themeStore';

  let { children }: { children?: Snippet } = $props();

  // This sync banner for app users — hide it on admin routes.
  const showSyncBanner = $derived(!page.url.pathname.startsWith('/admin'));

  // Mirror the resolved color mode onto <html> so global CSS / browser-native
  // UI (scrollbars, form controls) follows the active theme.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.colorMode = $activeColorMode;
    document.documentElement.style.colorScheme = $activeColorMode;
  });

  onMount(() => {
    registerServiceWorker();
    // Returns a teardown fn that onMount runs on unmount.
    return startSyncOrchestrator();
  });
</script>

<svelte:head>
  <title>EvolvTrack - Own your progress</title>
</svelte:head>

{#if showSyncBanner}
  <SyncBanner />
{/if}
{@render children?.()}

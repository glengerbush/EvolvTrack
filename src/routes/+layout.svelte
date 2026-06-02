<script lang="ts">
  import '$lib/styles/global.css';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { registerServiceWorker } from '$lib/utils/pwa';
  import { initInstallPrompt } from '$lib/stores/pwaInstallStore';
  import { startSyncOrchestrator } from '$lib/sync/sync-orchestrator';
  import SyncBanner from '$lib/components/sync/SyncBanner.svelte';
  import InstallBanner from '$lib/components/InstallBanner.svelte';
  import { activeColorMode } from '$lib/stores/themeStore';
  import { authState } from '$lib/stores/authStore';

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

  // The supabase client surfaces `signed-out-expired` when the refresh token
  // has been confirmed dead by the server (revoked, rotated elsewhere, panic
  // global signout). Drop the user straight onto the sign-in form rather than
  // stranding them on a stale dashboard. Don't wipe local data — they can
  // sign back in to the same account and pick up where they left off.
  $effect(() => {
    if ($authState.kind !== 'signed-out-expired') return;
    if (typeof window === 'undefined') return;
    const path = page.url.pathname;
    if (path.startsWith('/auth')) return;
    if (path === '/') return;
    window.location.assign('/auth');
  });

  onMount(() => {
    registerServiceWorker();
    initInstallPrompt();
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
<InstallBanner />
{@render children?.()}

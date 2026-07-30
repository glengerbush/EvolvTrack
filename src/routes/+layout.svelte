<script lang="ts">
  import '$lib/styles/global.css';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { registerServiceWorker } from '$lib/utils/pwa';
  import { initInstallPrompt } from '$lib/stores/pwaInstallStore';
  import { startSyncOrchestrator } from '$lib/sync/sync-orchestrator';
  import SyncGate from '$lib/components/sync/SyncGate.svelte';
  import InstallBanner from '$lib/components/InstallBanner.svelte';
  import StorageWarningBanner from '$lib/components/StorageWarningBanner.svelte';
  import { checkStorageHealth } from '$lib/stores/storageHealth';
  import { activeColorMode } from '$lib/stores/themeStore';
  import { authState } from '$lib/stores/authStore';

  let { children }: { children?: Snippet } = $props();

  // The sync gate (lock / migration modals) is for app users — hide it on
  // admin routes.
  const showSyncGate = $derived(!page.url.pathname.startsWith(resolve('/admin')));

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
    if (path.startsWith(resolve('/auth'))) return;
    if (path === resolve('/')) return;
    window.location.assign(resolve('/auth'));
  });

  onMount(() => {
    registerServiceWorker();
    initInstallPrompt();
    // Probe whether the browser can durably store data (warns on clear-on-close
    // / blocked-storage browsers instead of silently losing everything).
    void checkStorageHealth();
    // Returns a teardown fn that onMount runs on unmount.
    return startSyncOrchestrator();
  });
</script>

<svelte:head>
  <title>EvolvTrack - Own your progress</title>
</svelte:head>

{#if showSyncGate}
  <SyncGate />
  <StorageWarningBanner />
{/if}
<InstallBanner />
{@render children?.()}

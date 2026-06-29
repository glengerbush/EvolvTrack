<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import AuthTabs from '$lib/components/AuthTabs.svelte';
  import { resolveAppEntry } from '$lib/auth/resolveAppEntry';

  // This page is the PWA `start_url`, so it loads on every cold launch. A fresh
  // visitor stays here to log in / sign up / continue without an account, but a
  // returning user (restored session, in-progress demo, or local data on this
  // device) is sent straight into the app instead of being shown a login form.
  // The session restores asynchronously from IndexedDB, so resolveAppEntry waits
  // for a settled auth state rather than mis-reading the initial loading state.
  onMount(() => {
    let active = true;
    void resolveAppEntry().then((enter) => {
      if (active && enter) void goto('/app', { replaceState: true });
    });
    return () => {
      active = false;
    };
  });
</script>

<svelte:head>
  <title>Log in · EvolvTrack</title>
</svelte:head>

<AuthTabs initialTab="login" />

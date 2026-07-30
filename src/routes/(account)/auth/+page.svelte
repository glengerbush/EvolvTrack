<script lang="ts">
  import { onDestroy } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import AuthTabs from '$lib/components/AuthTabs.svelte';
  import { resolveAppEntry } from '$lib/auth/resolveAppEntry';

  // This page is the PWA `start_url`, so it loads on every cold launch. A fresh
  // visitor stays here to log in / sign up / continue without an account, but a
  // returning user (restored session, in-progress demo, or local data on this
  // device) is sent straight into the app instead of being shown a login form.
  // The session restores asynchronously from IndexedDB, so resolveAppEntry waits
  // for a settled auth state rather than mis-reading the initial loading state.
  //
  // Only do this on a genuine cold start (`navigation.type === 'enter'`) — not
  // on back/forward navigation within an already-running session, or landing
  // here via history navigation would immediately bounce back into the app.
  let active = true;
  onDestroy(() => {
    active = false;
  });
  afterNavigate((navigation) => {
    if (navigation.type !== 'enter') return;
    void resolveAppEntry().then((enter) => {
      if (active && enter) void goto(resolve('/app'), { replaceState: true });
    });
  });
</script>

<svelte:head>
  <title>Log in · EvolvTrack</title>
</svelte:head>

<AuthTabs initialTab="login" />

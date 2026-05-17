<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  onMount(() => {
    void goto('/app');
  });
</script>

<svelte:head>
  <title>Signing you in… · EvolvTrack</title>
</svelte:head>

<p class="container">Signing you in...</p>

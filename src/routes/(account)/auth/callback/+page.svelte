<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';

  onMount(() => {
    void goto(resolve('/app'));
  });
</script>

<svelte:head>
  <title>Signing you in… · EvolvTrack</title>
</svelte:head>

<p class="container">Signing you in...</p>

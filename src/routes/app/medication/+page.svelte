<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';

  onMount(() => {
    window.location.replace(resolve('/app') + '#medication');
  });
</script>

<svelte:head>
  <title>Medication · EvolvTrack</title>
</svelte:head>

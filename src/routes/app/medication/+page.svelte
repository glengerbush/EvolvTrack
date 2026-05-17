<script lang="ts">
  import { goto } from '$app/navigation';
  goto('/app#medication', { replaceState: true });
</script>

<svelte:head>
  <title>Medication · EvolvTrack</title>
</svelte:head>

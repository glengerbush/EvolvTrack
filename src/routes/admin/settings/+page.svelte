<script lang="ts">
  import AccountSettings from '$lib/components/settings/AccountSettings.svelte';
</script>

<svelte:head>
  <title>Admin settings · EvolvTrack</title>
</svelte:head>

<AccountSettings only={['appearance', 'password']} />

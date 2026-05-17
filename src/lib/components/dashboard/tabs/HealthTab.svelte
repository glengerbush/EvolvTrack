<script lang="ts">
  import SharedTabContent from '$lib/components/dashboard/tabs/SharedTabContent.svelte';

  let {
    active = true,
    discardSignal = 0,
    onUnsavedChange,
  }: {
    active?: boolean;
    discardSignal?: number;
    onUnsavedChange?: (hasUnsavedChanges: boolean) => void;
  } = $props();
</script>

<SharedTabContent {active} {discardSignal} {onUnsavedChange} />

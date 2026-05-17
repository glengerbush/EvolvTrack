<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import EditIcon from '$lib/components/icons/EditIcon.svelte';

  let {
    ariaLabel = 'Edit',
    active = false,
    onclick,
  }: {
    ariaLabel?: string;
    active?: boolean;
    onclick?: HTMLButtonAttributes['onclick'];
  } = $props();
</script>

<button class={['edit-pencil', { active }]} type="button" aria-label={ariaLabel} {onclick}>
  <EditIcon size="var(--edit-icon-scale)" color="white" active={active} />
</button>

<style>
  .edit-pencil {
    border: 0;
    border-radius: 10px;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: color-mix(in oklab, var(--headerBg) 88%, white 12%);
    line-height: 0;
    cursor: pointer;
    display: inline-grid;
    place-items: center;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cardBorder) 16%, transparent 84%);
    --edit-icon-scale: 60%;
  }

  .edit-pencil.active {
    background: color-mix(in oklab, var(--headerBg) 96%, #f2ca67 4%);
  }
</style>

<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children?: Snippet } = $props();
</script>

<div class="page">
  {@render children?.()}
</div>

<style>
  .page {
    /* Match the landing page: graphite base with a graph-paper grid. */
    background-color: #e8ebee;
    background-image:
      linear-gradient(to right, rgba(60, 70, 80, 0.12) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(60, 70, 80, 0.12) 1px, transparent 1px);
    background-size: 30px 30px;
    min-height: 100dvh;
  }
  :global(html[data-color-mode='dark']) .page {
    background-color: #1d2024;
    background-image:
      linear-gradient(to right, rgba(220, 230, 240, 0.08) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(220, 230, 240, 0.08) 1px, transparent 1px);
  }
</style>

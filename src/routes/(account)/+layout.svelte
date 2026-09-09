<script lang="ts">
  import type { Snippet } from 'svelte';
  import GraphPaperBackground from '$lib/components/GraphPaperBackground.svelte';
  let { children }: { children?: Snippet } = $props();
</script>

<div class="page">
  <GraphPaperBackground patternId="account-graph-paper" />
  {@render children?.()}
</div>

<style>
  .page {
    /* Match the landing page: graphite base with a graph-paper grid. */
    --graph-paper-line-color: rgba(60, 70, 80, 0.12);
    position: relative;
    isolation: isolate;
    background-color: #e8ebee;
    min-height: 100dvh;
  }
  :global(html[data-color-mode='dark']) .page {
    --graph-paper-line-color: rgba(220, 230, 240, 0.08);
    background-color: #1d2024;
  }
</style>

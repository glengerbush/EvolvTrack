<script lang="ts">
  import { onMount } from 'svelte';
  import { getGraphPaperMetrics } from '$lib/styles/graphPaper';

  let { patternId }: { patternId: string } = $props();
  let metrics = $state.raw(getGraphPaperMetrics(1));

  function refreshMetrics() {
    metrics = getGraphPaperMetrics(window.devicePixelRatio);
  }

  onMount(() => {
    refreshMetrics();
    window.visualViewport?.addEventListener('resize', refreshMetrics);

    return () => window.visualViewport?.removeEventListener('resize', refreshMetrics);
  });
</script>

<svelte:window onresize={refreshMetrics} />

<svg
  class="graph-paper-background"
  style:width={`${metrics.scale * 100}%`}
  style:height={`${metrics.scale * 100}%`}
  style:transform={`scale(${metrics.inverseScale})`}
  aria-hidden="true"
  focusable="false"
  shape-rendering="crispEdges"
>
  <defs>
    <pattern
      id={patternId}
      width={metrics.cellPixels}
      height={metrics.cellPixels}
      patternUnits="userSpaceOnUse"
    >
      <rect
        width={metrics.linePixels}
        height={metrics.cellPixels}
        fill="var(--graph-paper-line-color)"
      />
      <rect
        width={metrics.cellPixels}
        height={metrics.linePixels}
        fill="var(--graph-paper-line-color)"
      />
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill={`url(#${patternId})`} />
</svg>

<style>
  .graph-paper-background {
    position: absolute;
    inset: 0;
    z-index: -1;
    display: block;
    max-width: none;
    overflow: hidden;
    pointer-events: none;
    transform-origin: top left;
  }
</style>

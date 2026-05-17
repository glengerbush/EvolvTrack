<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import SyncStatusPill from '$lib/components/sync/SyncStatusPill.svelte';

  let { title = 'EVOLVETRACK', children }: { title?: string; children?: Snippet } = $props();
</script>

<div class="shell">
  <header>
    <div class="brand">✽ {title}</div>
    <nav>
      <a href={resolve('/app')}>Health</a>
      <a href={resolve('/app/medication')}>Medication</a>
      <a href={resolve('/settings')}>Settings</a>
      <SyncStatusPill />
    </nav>
  </header>
  <main>{@render children?.()}</main>
</div>

<style>
  .shell { min-height: 100dvh; }
  header {
    position: sticky; top: 0; z-index: 5;
    background: color-mix(in oklab, var(--surface) 90%, transparent);
    backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.85rem 1rem; border-bottom: 1px solid color-mix(in oklab, var(--cardBorder, #d7d7d7) 40%, transparent);
  }
  .brand { font-weight: 800; letter-spacing: .02em; }
  nav { display: flex; align-items: center; gap: .7rem; font-size: .95rem; }
  main { padding: 1rem; }
</style>

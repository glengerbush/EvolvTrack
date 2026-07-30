<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import SyncStatusPill from '$lib/components/sync/SyncStatusPill.svelte';
  import { logoutAndClearLocalData } from '$lib/auth/supabase';

  type NavItem = { label: string; href: string };

  let {
    title = 'EVOLVETRACK',
    showAppNav = true,
    showSyncPill = true,
    showLogout = false,
    navItems = [],
    children,
  }: {
    title?: string;
    /** Hide the Health/Medication/Settings nav links — used by standalone
     *  surfaces like the admin view that aren't part of the main app flow. */
    showAppNav?: boolean;
    /** Show the sync status pill in the top-right. Off for surfaces where
     *  sync state isn't actionable (e.g. admin). */
    showSyncPill?: boolean;
    /** Show a "Log out" button. Off by default — the dashboard provides its
     *  own logout flow with unsaved-changes guarding. */
    showLogout?: boolean;
    /** Caller-supplied nav links, rendered after the standard app nav (or in
     *  its place when showAppNav is false). Lets standalone surfaces like the
     *  admin view expose their own top-bar navigation. */
    navItems?: NavItem[];
    children?: Snippet;
  } = $props();

  async function handleLogout() {
    try {
      await logoutAndClearLocalData();
    } finally {
      window.location.href = resolve('/auth');
    }
  }
</script>

<div class="shell">
  <header>
    <div class="brand-lockup" aria-label={title}>
      <span class="brand-icon" role="img" aria-label="EvolvTrack logo"></span>
      <span class="brand-name">{title}</span>
    </div>
    <nav>
      {#if showAppNav}
        <a href={resolve('/app')}>Health</a>
        <a href={resolve('/app/medication')}>Medication</a>
        <a href={resolve('/app') + '#settings'}>Settings</a>
      {/if}
      {#each navItems as item (item.href)}
        <a href={item.href}>{item.label}</a>
      {/each}
      {#if showSyncPill}
        <SyncStatusPill />
      {/if}
      {#if showLogout}
        <button class="logout-btn" type="button" onclick={handleLogout}>Log out</button>
      {/if}
    </nav>
  </header>
  <main>{@render children?.()}</main>
</div>

<style>
  .shell { min-height: 100dvh; color: var(--text); }
  header {
    position: sticky; top: 0; z-index: 5;
    background: color-mix(in oklab, var(--surface) 90%, transparent);
    backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid color-mix(in oklab, var(--text) 14%, transparent);
  }
  .brand-lockup {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }
  .brand-icon {
    width: 1.9rem;
    height: 1.9rem;
    border-radius: 7px;
    border: 1px solid var(--brand);
    background-color: var(--brand);
    flex: 0 0 auto;
    display: inline-block;
    position: relative;
  }
  /* Logo shape is fixed white regardless of color mode — matches the
   * Dashboard's brand lockup pattern. */
  .brand-icon::before {
    content: "";
    position: absolute;
    inset: 5% 5% 0% 0;
    background-color: #ffffff;
    -webkit-mask: url('/logo.svg') no-repeat center / 120% 120%;
    mask: url('/logo.svg') no-repeat center / 120% 120%;
  }
  .brand-name {
    font-weight: 800;
    letter-spacing: .02em;
    font-size: 1.05rem;
    color: var(--text);
  }
  nav { display: flex; align-items: center; gap: .7rem; font-size: .95rem; }
  nav a { color: var(--text); }
  .logout-btn {
    appearance: none;
    border: 1px solid color-mix(in oklab, var(--text) 22%, transparent);
    background: transparent;
    color: var(--text);
    border-radius: 999px;
    padding: 0.3rem 0.85rem;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .logout-btn:hover { background: color-mix(in oklab, var(--text) 6%, transparent); }
  main { padding: 1rem; }
</style>

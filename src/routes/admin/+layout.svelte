<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import AppShell from '$lib/components/AppShell.svelte';
  import { activeTabThemes } from '$lib/stores/themeStore';

  let { children }: { children?: Snippet } = $props();

  const navItems = [
    { label: 'Licenses', href: resolve('/admin') },
    { label: 'Settings', href: resolve('/admin/settings') },
  ];

  // The admin shell sits outside the Dashboard component, so it doesn't
  // inherit the dashboard's inline theme variables (--cardBorder, --headerBg,
  // …). Pull the settings-tab palette and apply it on the layout root so
  // AccountSettings and other shared chrome render with theme-aware colors.
  const t = $derived($activeTabThemes.settings);
</script>

<div
  class="admin-themed"
  style:--bgTint={t.bgTint}
  style:--gridLine={t.gridLine}
  style:--cardBorder={t.cardBorder}
  style:--headerBg={t.headerBg}
  style:--headerText={t.headerText}
  style:--accent={t.accent}
  style:--warning={t.warning}
  style:--success={t.success}
  style:--danger={t.danger}
  style:--stripe={t.stripe}
  style:--rowAlt={t.rowAlt}
>
  <AppShell showAppNav={false} showSyncPill={false} showLogout {navItems}>
    {@render children?.()}
  </AppShell>
</div>

<style>
  .admin-themed { min-height: 100dvh; }
</style>

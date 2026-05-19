<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { activeColorMode, activeTabThemes, activeTheme } from "$lib/stores/themeStore";
  import { drugPalettes } from "$lib/theme/dashboardTheme";
  import { isDemoMode } from "$lib/stores/demoStore";
  import { authState } from "$lib/stores/authStore";
  import { setupWizardPending } from "$lib/stores/setupWizardStore";
  import { APP_VERSION } from "$lib/version";
  import { logoutAndClearLocalData } from "$lib/auth/supabase";
  import { updateAvailable, applyUpdate } from "$lib/utils/pwa";
  import SetupWizard from "$lib/components/SetupWizard.svelte";
  import SyncStatusPill from "$lib/components/sync/SyncStatusPill.svelte";
  import HealthTab from "$lib/components/dashboard/tabs/HealthTab.svelte";
  import MedicationTab from "$lib/components/dashboard/tabs/MedicationTab.svelte";
  import CalculatorsTab from "$lib/components/dashboard/tabs/CalculatorsTab.svelte";
  import InfoTab from "$lib/components/dashboard/tabs/InfoTab.svelte";
  import SettingsTab from "$lib/components/dashboard/tabs/SettingsTab.svelte";

  type ActiveTab = "health" | "medication" | "calculators" | "info" | "settings";
  type TopTab = { key: ActiveTab; label: string; iconOnly?: boolean };
  const UNSAVED_NAVIGATION_MESSAGE = "Unsaved data will be lost. Are you sure you want to navigate away?";

  const topTabs: TopTab[] = [
    { key: "health", label: "Health" },
    { key: "medication", label: "Medication" },
    { key: "calculators", label: "Calculators" },
    { key: "info", label: "Info" },
    { key: "settings", label: "Settings", iconOnly: true },
  ];

  const validTabs = new Set<ActiveTab>(["health", "medication", "calculators", "info", "settings"]);

  function tabFromHash(): ActiveTab {
    if (typeof window === "undefined") return "health";
    const hash = window.location.hash.slice(1) as ActiveTab;
    return validTabs.has(hash) ? hash : "health";
  }

  let activeTab = $state<ActiveTab>(tabFromHash());
  let tabsWithUnsavedChanges = $state<Record<ActiveTab, boolean>>({
    health: false,
    medication: false,
    calculators: false,
    info: false,
    settings: false,
  });
  let discardSignals = $state<Record<ActiveTab, number>>({
    health: 0,
    medication: 0,
    calculators: 0,
    info: 0,
    settings: 0,
  });
  let suppressNextHashChange = false;

  $effect(() => {
    const nextHash = `#${activeTab}`;
    if (window.location.hash === nextHash) return;
    suppressNextHashChange = true;
    window.location.hash = activeTab;
  });

  let lastScrollResetTab: ActiveTab | null = null;
  $effect(() => {
    const tab = activeTab;
    if (lastScrollResetTab === null) {
      lastScrollResetTab = tab;
      return;
    }
    if (lastScrollResetTab === tab) return;
    lastScrollResetTab = tab;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });

  $effect(() => {
    function onHashChange() {
      if (suppressNextHashChange) {
        suppressNextHashChange = false;
        return;
      }
      const next = tabFromHash();
      if (next === activeTab) return;
      if (!confirmActiveTabNavigation()) {
        suppressNextHashChange = true;
        window.location.hash = activeTab;
        return;
      }
      discardTabChanges(activeTab);
      activeTab = next;
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  });

  const theme = $derived($activeTabThemes[activeTab]);
  const drugPalette = $derived(drugPalettes[$activeTheme][$activeColorMode]);
  const drugVars = $derived(
    [
      `--drug-sema:${drugPalette.sema}`,
      `--drug-tirz:${drugPalette.tirz}`,
      `--drug-dula:${drugPalette.dula}`,
      `--drug-lira:${drugPalette.lira}`,
      `--drug-reta:${drugPalette.reta}`,
      ...drugPalette.fallback.map((c, i) => `--drug-palette-${i}:${c}`),
    ].join('; '),
  );

  const tabTitles: Record<ActiveTab, string> = {
    health: 'Health',
    medication: 'Medication',
    calculators: 'Calculators',
    info: 'Info',
    settings: 'Settings',
  };
  const pageTitle = $derived(`${tabTitles[activeTab]} · EvolvTrack`);
  const hasAnyUnsavedChanges = $derived(
    Object.values(tabsWithUnsavedChanges).some(Boolean),
  );

  function setTabUnsavedChanges(tab: ActiveTab, hasUnsavedChanges: boolean) {
    if (tabsWithUnsavedChanges[tab] === hasUnsavedChanges) return;
    tabsWithUnsavedChanges = { ...tabsWithUnsavedChanges, [tab]: hasUnsavedChanges };
  }

  function discardTabChanges(tab: ActiveTab) {
    if (!tabsWithUnsavedChanges[tab]) return;
    discardSignals = { ...discardSignals, [tab]: discardSignals[tab] + 1 };
    tabsWithUnsavedChanges = { ...tabsWithUnsavedChanges, [tab]: false };
  }

  function confirmActiveTabNavigation() {
    if (!tabsWithUnsavedChanges[activeTab]) return true;
    return confirm(UNSAVED_NAVIGATION_MESSAGE);
  }

  function navigateToTab(tab: ActiveTab) {
    if (tab === activeTab) return;
    if (!confirmActiveTabNavigation()) return;
    discardTabChanges(activeTab);
    activeTab = tab;
  }

  function handleBeforeUnload(event: BeforeUnloadEvent) {
    if (!hasAnyUnsavedChanges) return;
    event.preventDefault();
    event.returnValue = UNSAVED_NAVIGATION_MESSAGE;
  }

  async function handleLogout() {
    if (hasAnyUnsavedChanges && !confirm(UNSAVED_NAVIGATION_MESSAGE)) return;
    try {
      await logoutAndClearLocalData();
    } finally {
      window.location.href = "/auth";
    }
  }

  // Topbar button mode:
  //   - signed-in: "Log out" (wipes local data on the way out)
  //   - demo:     "Exit demo" (wipes demo seed data, returns to landing)
  //   - offline (not demo, not signed-in): "Sign up" CTA that preserves data
  const topbarAuthMode = $derived<'logout' | 'signup' | 'exit-demo'>(
    $authState.kind === 'signed-in' ? 'logout' : $isDemoMode ? 'exit-demo' : 'signup',
  );

  function handleSignUp() {
    if (hasAnyUnsavedChanges && !confirm(UNSAVED_NAVIGATION_MESSAGE)) return;
    window.location.href = resolve('/register');
  }

  async function handleExitDemo() {
    if (hasAnyUnsavedChanges && !confirm(UNSAVED_NAVIGATION_MESSAGE)) return;
    // Navigate away first so the dashboard unmounts before the demo badge
    // disappears and demo rows blink out — otherwise the user sees the
    // topbar flip to "Sign up" while data is still being cleared.
    await goto(resolve('/'));
    await isDemoMode.disable();
  }
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

<svelte:window onbeforeunload={handleBeforeUnload} />

<div
  class="dashboard"
  style={`--bgTint:${theme.bgTint}; --gridLine:${theme.gridLine}; --cardBorder:${theme.cardBorder}; --headerBg:${theme.headerBg}; --headerText:${theme.headerText}; --accent:${theme.accent}; --warning:${theme.warning}; --success:${theme.success}; --danger:${theme.danger}; --stripe:${theme.stripe}; --rowAlt:${theme.rowAlt}; --vialActive:${theme.vialActive}; --vialWarning:${theme.vialWarning}; --weightLine:${theme.weightLine}; --wellnessBar:${theme.wellnessBar}; --symptomMarker:${theme.symptomMarker}; ${drugVars};`}
>
  <header class="app-topbar">
    <div class="brand-lockup" aria-label="EvolvTrack">
      <span class="brand-icon" role="img" aria-label="EvolvTrack logo"></span>
      <span class="brand-name">EvolvTrack</span>
      <span class="version-badge">v{APP_VERSION}</span>
      {#if $isDemoMode}
        <span class="demo-badge">Demo</span>
      {/if}
    </div>
    <div class="topbar-right">
      {#if $updateAvailable}
        <button class="update-button" onclick={applyUpdate}>Update available</button>
      {/if}
      <SyncStatusPill />
      {#if topbarAuthMode === 'logout'}
        <button class="logout-button" onclick={handleLogout}>Log out</button>
      {:else if topbarAuthMode === 'signup'}
        <button class="signup-button" onclick={handleSignUp}>Sign up</button>
      {:else if topbarAuthMode === 'exit-demo'}
        <button class="logout-button" onclick={handleExitDemo}>Exit demo</button>
      {/if}
    </div>
  </header>

  {#if $setupWizardPending && $authState.kind === 'signed-in'}
    <SetupWizard />
  {/if}

  <header class="tabbar">
    <nav class="top-tabs" aria-label="Dashboard tabs">
      {#each topTabs as tab (tab.key)}
        <button
          class="top-tab"
          class:active={activeTab === tab.key}
          class:icon-only={tab.iconOnly}
          style={`--tabBase:${$activeTabThemes[tab.key].tabBase}; --tabText:${$activeTabThemes[tab.key].tabText};`}
          onclick={() => navigateToTab(tab.key)}
          aria-label={tab.iconOnly ? tab.label : undefined}
        >
          {#if tab.iconOnly}
            <span class="top-tab-icon-box">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" aria-hidden="true">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
              </svg>
            </span>
          {:else}
            {tab.label}
          {/if}
        </button>
      {/each}
    </nav>
  </header>

  <section class="tab-panel" hidden={activeTab !== 'health'} aria-hidden={activeTab !== 'health'}>
    <HealthTab
      active={activeTab === 'health'}
      discardSignal={discardSignals.health}
      onUnsavedChange={(hasUnsavedChanges) => setTabUnsavedChanges('health', hasUnsavedChanges)}
    />
  </section>
  <section class="tab-panel" hidden={activeTab !== 'medication'} aria-hidden={activeTab !== 'medication'}>
    <MedicationTab
      active={activeTab === 'medication'}
      discardSignal={discardSignals.medication}
      onUnsavedChange={(hasUnsavedChanges) => setTabUnsavedChanges('medication', hasUnsavedChanges)}
    />
  </section>
  <section class="tab-panel" hidden={activeTab !== 'calculators'} aria-hidden={activeTab !== 'calculators'}>
    <CalculatorsTab />
  </section>
  <section class="tab-panel" hidden={activeTab !== 'info'} aria-hidden={activeTab !== 'info'}>
    <InfoTab />
  </section>
  <section class="tab-panel" hidden={activeTab !== 'settings'} aria-hidden={activeTab !== 'settings'}>
    <SettingsTab />
  </section>
</div>

<style>
  .dashboard {
    min-height: 100dvh;
    background-color: var(--bgTint);
    background-image: linear-gradient(
        to right,
        var(--gridLine) 1px,
        transparent 1px
      ),
      linear-gradient(to bottom, var(--gridLine) 1px, transparent 1px);
    background-size: 30px 30px;
  }

  .app-topbar {
    min-height: 4.25rem;
    padding: 0.7rem 1.2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    border-bottom: 3px solid color-mix(in oklab, var(--cardBorder) 55%, white 45%);
    background: color-mix(in oklab, var(--bgTint) 60%, white 40%);
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-shrink: 0;
  }

  .brand-lockup {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    min-width: 0;
  }

  .brand-icon {
    width: 2.35rem;
    height: 2.35rem;
    border-radius: 8px;
    border: 2px solid var(--cardBorder);
    flex: 0 0 auto;
    display: inline-block;
    position: relative;
    background-color: var(--cardBorder);
  }

  .brand-icon::before {
    content: "";
    position: absolute;
    inset: 5% 5% 0% 0;
    background-color: #ffffff;
    -webkit-mask: url('/logo.svg') no-repeat center / 120% 120%;
    mask: url('/logo.svg') no-repeat center / 120% 120%;
  }

  .brand-name {
    color: var(--text);
    font-size: 1.35rem;
    font-weight: 800;
    line-height: 1;
  }

  .version-badge {
    border: 2px solid color-mix(in oklab, var(--cardBorder) 42%, transparent 58%);
    border-radius: 999px;
    background: color-mix(in oklab, var(--surface) 66%, transparent);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 800;
    line-height: 1;
    padding: 0.28rem 0.48rem;
    white-space: nowrap;
  }

  .update-button {
    border: 2px solid var(--success, #16a34a);
    border-radius: 10px;
    background: color-mix(in oklab, var(--success, #16a34a) 15%, white 85%);
    color: color-mix(in oklab, var(--success, #16a34a) 40%, black 60%);
    font-weight: 700;
    font-size: 0.88rem;
    cursor: pointer;
    padding: 0.3rem 0.8rem;
    white-space: nowrap;
    animation: pulse-accent 2s ease-in-out infinite;
  }

  @keyframes pulse-accent {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--success, #16a34a) 40%, transparent 60%); }
    50% { box-shadow: 0 0 0 5px color-mix(in oklab, var(--success, #16a34a) 0%, transparent 100%); }
  }

  .tabbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.2rem 0;
    border-bottom: 4px solid var(--cardBorder);
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--surface);
  }

  .demo-badge {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: color-mix(in oklab, var(--warning, #f59e0b) 80%, white 20%);
    color: #1a1000;
    border-radius: 6px;
    padding: 0.2rem 0.55rem;
  }

  .logout-button,
  .signup-button {
    border: 3px solid var(--cardBorder);
    border-radius: 12px;
    background: color-mix(in oklab, var(--headerBg) 60%, white 40%);
    color: var(--headerText);
    font-weight: 700;
    cursor: pointer;
    padding: 0 0.85rem;
    height: 3rem;
    font-size: 1rem;
  }

  .signup-button {
    background: var(--headerBg);
    color: var(--headerText);
  }

  .top-tabs {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .top-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.38rem;
    border: 3px solid transparent;
    border-bottom: 0;
    border-top-left-radius: 14px;
    border-top-right-radius: 14px;
    padding: 0rem 1.2rem;
    font-size: 1.1rem;
    font-weight: 700;
    font-variant: small-caps;
    background: var(--tabBase);
    color: var(--tabText);
    cursor: pointer;
    line-height: 1;
    text-decoration: none;
  }

  .tab-panel[hidden] {
    display: none !important;
  }

  .top-tab.icon-only {
    padding: 0 0.5em 0 0.5em;
  }

  .top-tab-icon-box {
    display: inline-grid;
    place-items: center;
    width: 2.65rem;
    height: 2.65rem;
    line-height: 0;
  }

  .top-tab-icon-box svg {
    width: 85%;
    height: 85%;
    fill: var(--tabText);
  }

  .top-tab.active {
    border-color: var(--cardBorder);
    box-shadow: inset 0 0 0 2px
      color-mix(in oklab, var(--headerBg) 35%, transparent);
    color: var(--tabText);
  }

  @media (max-width: 1024px) {
    .app-topbar {
      min-height: 3.6rem;
      padding: 0.55rem 0.85rem;
    }

    .brand-icon {
      width: 2rem;
      height: 2rem;
    }

    .brand-name {
      font-size: 1.08rem;
    }

    .version-badge {
      font-size: 0.72rem;
    }

    .logout-button,
    .signup-button {
      height: 2.45rem;
      font-size: 0.9rem;
    }
  }

  @media (max-width: 560px) {
    .app-topbar {
      align-items: flex-start;
      flex-direction: column;
    }

    .logout-button,
    .signup-button {
      width: 100%;
    }
  }
</style>

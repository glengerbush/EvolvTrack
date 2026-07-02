<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { activeColorMode, activeTabThemes, activeTheme } from "$lib/stores/themeStore";
  import { drugPalettes } from "$lib/theme/dashboardTheme";
  import { isDemoMode } from "$lib/stores/demoStore";
  import { authState } from "$lib/stores/authStore";
  import { setupWizardPending } from "$lib/stores/setupWizardStore";
  import { logoutAndClearLocalData } from "$lib/auth/supabase";
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
    const hash = window.location.hash.slice(1);
    if (validTabs.has(hash as ActiveTab)) return hash as ActiveTab;
    // An in-page FAQ anchor (e.g. #faq-offline) is a deep link into the Info
    // tab's FAQ; open that tab so the Info tab can scroll to the question.
    if (hash.startsWith("faq-")) return "info";
    return "health";
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
  let initialHashFilled = false;

  $effect(() => {
    const nextHash = `#${activeTab}`;
    if (window.location.hash === nextHash) return;
    // Preserve an in-page FAQ deep-link fragment (#faq-…) on the Info tab so it
    // isn't clobbered before the Info tab scrolls to the question on load.
    if (activeTab === "info" && window.location.hash.slice(1).startsWith("faq-")) return;
    if (!initialHashFilled) {
      initialHashFilled = true;
      // A bare `/app` load has no hash yet; fill in the default tab via
      // replaceState so it doesn't push a history entry (setting
      // `location.hash` directly, like a real tab switch below, always
      // pushes) — otherwise landing on `/app` leaves an extra `/app` ->
      // `/app#health` step to click through on the way back. replaceState
      // doesn't fire `hashchange`, so there's nothing to suppress here.
      history.replaceState(history.state, "", nextHash);
      return;
    }
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
      // Ignore hashes that aren't tab names — they're in-page anchors
      // (e.g. the FAQ table of contents in the Info tab). Letting the
      // fallback in tabFromHash() take over would yank the user back to
      // the Health tab whenever they clicked an in-page link.
      const rawHash = window.location.hash.slice(1) as ActiveTab;
      if (!validTabs.has(rawHash)) return;
      if (rawHash === activeTab) return;
      if (!confirmActiveTabNavigation()) {
        suppressNextHashChange = true;
        window.location.hash = activeTab;
        return;
      }
      discardTabChanges(activeTab);
      activeTab = rawHash;
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
      <span class="brand-text">
        <span class="brand-name">EvolvTrack</span>
        {#if $isDemoMode}
          <span class="demo-badge">Demo</span>
        {/if}
      </span>
    </div>
    <div class="topbar-right">
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
                <path d="M19.14 12.94c.04-.31.06-.62.06-.94 0-.32-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.71 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.62-.06.94 0 .32.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.13.23.41.31.59.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54c.05.24.27.42.5.42h3.84c.23 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96c.18.09.46.01.59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>
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
    border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 55%, white 45%);
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

  /* Wraps the wordmark + Demo badge. On desktop they sit side by side; on mobile
   * (≤560px) the badge stacks above the wordmark (column-reverse) so it costs no
   * horizontal room and the pill + button stay on the same row as the logo. */
  .brand-text {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }

  .brand-icon {
    width: 2.35rem;
    height: 2.35rem;
    border-radius: 8px;
    border: 1px solid var(--cardBorder);
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
    /* Shrink valve: if a width is ever too tight, the wordmark truncates rather
     * than wrapping the bar or pushing the pill/button off-row. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tabbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.2rem 0;
    border-bottom: 1px solid var(--cardBorder);
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
    border: 1px solid var(--cardBorder);
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
    flex-wrap: nowrap;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .top-tabs::-webkit-scrollbar {
    display: none;
  }

  .top-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.38rem;
    border: 1px solid transparent;
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
    flex: 0 0 auto;
    white-space: nowrap;
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

    .logout-button,
    .signup-button {
      height: 2.45rem;
      font-size: 0.9rem;
    }
  }

  @media (max-width: 640px) {
    .tabbar {
      padding: 0.5rem 0.55rem 0;
      gap: 0.5rem;
    }

    .top-tabs {
      gap: 0.4rem;
    }

    .top-tab {
      padding: 0 0.8rem;
      font-size: 0.95rem;
    }

    .top-tab-icon-box {
      width: 2.1rem;
      height: 2.1rem;
    }
  }

  /* Keep the top bar a single row on phones (logo + sync pill + action button).
   * The right-hand controls never shrink/wrap; the brand side gives way first
   * (wordmark truncates via the ellipsis valve only as a last resort). */
  @media (max-width: 560px) {
    .app-topbar {
      padding: 0.5rem 0.6rem;
      gap: 0.5rem;
    }

    .brand-lockup {
      gap: 0.45rem;
      flex-shrink: 1;
    }

    .brand-text {
      flex-direction: column-reverse;
      align-items: flex-start;
      gap: 0.14rem;
    }

    .brand-icon {
      width: 1.85rem;
      height: 1.85rem;
    }

    .brand-name {
      font-size: 1rem;
    }

    .demo-badge {
      font-size: 0.6rem;
      padding: 0.07rem 0.32rem;
      letter-spacing: 0.04em;
    }

    .topbar-right {
      gap: 0.4rem;
    }

    .logout-button,
    .signup-button {
      height: 2.2rem;
      font-size: 0.82rem;
      padding: 0 0.6rem;
      border-width: 1px;
      border-radius: 10px;
    }
  }

  /* Very narrow phones (original iPhone SE, 320px): tighten further so the
   * full "EvolvTrack" wordmark still fits beside the pill and button. */
  @media (max-width: 400px) {
    .app-topbar {
      padding: 0.5rem 0.5rem;
      gap: 0.4rem;
    }

    .brand-icon {
      width: 1.6rem;
      height: 1.6rem;
    }

    .brand-name {
      font-size: 0.92rem;
    }

    .topbar-right {
      gap: 0.35rem;
    }

    .logout-button,
    .signup-button {
      height: 2.1rem;
      font-size: 0.78rem;
      padding: 0 0.5rem;
    }
  }
</style>

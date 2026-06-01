<script lang="ts">
  import { activeColorMode, activeTheme, themeOverrides, overrideKey } from '$lib/stores/themeStore';
  import {
    themes,
    DASHBOARD_TABS,
    DASHBOARD_THEME_KEYS,
    THEME_NAMES,
    COLOR_MODES,
    type ColorMode,
    type DashboardTab,
    type DashboardTheme,
    type ThemeName,
  } from '$lib/theme/dashboardTheme';

  let selectedTheme = $state<ThemeName>($activeTheme);
  let selectedMode = $state<ColorMode>($activeColorMode);
  let selectedTab = $state<DashboardTab>('health');
  let open = $state(false);
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');

  const base = $derived(themes[selectedTheme][selectedMode][selectedTab]);
  const currentOverrides = $derived(
    $themeOverrides[overrideKey(selectedTheme, selectedMode, selectedTab)] ?? {},
  );
  const merged = $derived<DashboardTheme>({ ...base, ...currentOverrides });
  const overrideCount = $derived(Object.keys(currentOverrides).length);

  // <input type="color"> requires #RRGGBB. Best-effort coerce any CSS color string.
  function toHex(value: string): string {
    const v = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7);
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      const [, r, g, b] = v;
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      const [, r, g, b] = m;
      const hh = (n: string) => Number(n).toString(16).padStart(2, '0');
      return `#${hh(r)}${hh(g)}${hh(b)}`;
    }
    return '#000000';
  }

  function setField(field: keyof DashboardTheme, value: string) {
    themeOverrides.setField(selectedTheme, selectedMode, selectedTab, field, value);
  }

  function clearField(field: keyof DashboardTheme) {
    themeOverrides.clearField(selectedTheme, selectedMode, selectedTab, field);
  }

  function resetTab() {
    themeOverrides.resetTab(selectedTheme, selectedMode, selectedTab);
  }

  async function copyAsJson() {
    const lines = DASHBOARD_THEME_KEYS.map((k) => `  ${k}: ${JSON.stringify(merged[k])},`);
    const text = `{\n${lines.join('\n')}\n}`;
    try {
      await navigator.clipboard.writeText(text);
      copyState = 'copied';
    } catch {
      copyState = 'failed';
    }
    setTimeout(() => { copyState = 'idle'; }, 1500);
  }
</script>

<details class="tuner" bind:open>
  <summary>
    Theme tuner <span class="dev-badge">dev only</span>
    {#if overrideCount > 0}
      <span class="override-badge">{overrideCount} overridden</span>
    {/if}
  </summary>

  {#if open}
    <div class="tuner-body">
      <div class="selectors">
        <label>
          <span>Theme</span>
          <select bind:value={selectedTheme}>
            {#each THEME_NAMES as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Mode</span>
          <select bind:value={selectedMode}>
            {#each COLOR_MODES as m (m)}
              <option value={m}>{m}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Tab</span>
          <select bind:value={selectedTab}>
            {#each DASHBOARD_TABS as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
        </label>
      </div>

      <p class="hint">
        Editing <code>{selectedTheme} / {selectedMode} / {selectedTab}</code>. Overrides persist in
        <code>localStorage</code> and apply live only when this matches the active theme/mode.
        Use <strong>Copy as JSON</strong> to paste a perfected tab back into
        <code>src/lib/theme/dashboardTheme.ts</code>.
      </p>

      <div class="actions">
        <button type="button" class="btn" onclick={copyAsJson}>
          {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed' : 'Copy as JSON'}
        </button>
        <button type="button" class="btn btn-warn" onclick={resetTab} disabled={overrideCount === 0}>
          Reset this tab
        </button>
        <button type="button" class="btn btn-warn" onclick={() => themeOverrides.resetAll()}>
          Reset all overrides
        </button>
      </div>

      <div class="fields">
        {#each DASHBOARD_THEME_KEYS as field (field)}
          {@const isOverridden = field in currentOverrides}
          {@const value = merged[field]}
          <div class="field" class:is-overridden={isOverridden}>
            <span class="swatch" style:background={value}></span>
            <label class="field-label" for={`tuner-${field}`}>{field}</label>
            <input
              id={`tuner-${field}`}
              type="text"
              class="text"
              value={value}
              onchange={(e) => setField(field, e.currentTarget.value)}
            />
            <input
              type="color"
              class="color"
              value={toHex(value)}
              oninput={(e) => setField(field, e.currentTarget.value)}
              title="Hex picker (use text field for rgba)"
            />
            <button
              type="button"
              class="reset"
              onclick={() => clearField(field)}
              disabled={!isOverridden}
              title="Revert to base"
            >↺</button>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</details>

<style>
  .tuner {
    margin-top: 1rem;
    border: 1px dashed color-mix(in oklab, var(--cardBorder) 60%, transparent 40%);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    background: color-mix(in oklab, var(--bgTint, #fff) 70%, transparent 30%);
    font-size: 0.85rem;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .dev-badge {
    background: #f59e0b;
    color: #1a1a1a;
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .override-badge {
    background: var(--accent, #2563eb);
    color: white;
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .tuner-body {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .selectors {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .selectors label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.75rem;
  }
  .selectors select {
    font-size: 0.85rem;
    padding: 0.25rem 0.4rem;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.4;
    opacity: 0.85;
  }
  .hint code {
    background: rgba(0, 0, 0, 0.08);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-size: 0.7rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .btn {
    font-size: 0.75rem;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    border: 1px solid var(--cardBorder);
    background: #f0f0f0;
    color: #444;
    cursor: pointer;
    transition: background 150ms, color 150ms;
  }
  .btn:hover:not(:disabled) {
    background: var(--headerBg);
    color: var(--headerText);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-warn {
    border-color: #b91c1c;
    color: #b91c1c;
  }
  .btn-warn:hover:not(:disabled) {
    background: #b91c1c;
    color: white;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field {
    display: grid;
    /* minmax(0, 9rem) lets the label column shrink on very narrow phones
     * (≤320px) instead of forcing the row — and the page — to overflow. */
    grid-template-columns: 1.4rem minmax(0, 9rem) 1fr 2.2rem 1.6rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0.3rem;
    border-radius: 3px;
  }
  .field.is-overridden {
    background: color-mix(in oklab, var(--accent, #2563eb) 12%, transparent 88%);
  }
  .swatch {
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 3px;
    border: 1px solid rgba(0, 0, 0, 0.2);
  }
  .field-label {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .text {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, transparent 60%);
    border-radius: 3px;
    min-width: 0;
  }
  .color {
    width: 2rem;
    height: 1.6rem;
    padding: 0;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, transparent 60%);
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
  }
  .reset {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1rem;
    opacity: 0.6;
    padding: 0;
  }
  .reset:disabled {
    opacity: 0.2;
    cursor: not-allowed;
  }
</style>

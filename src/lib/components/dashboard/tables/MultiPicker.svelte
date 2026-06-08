<script lang="ts">
  import { tick } from 'svelte';

  let {
    values = [],
    options = [],
    onToggle,
    ariaLabel,
    optionColor,
    forceOpen = false,
    onRequestClose,
  }: {
    values?: string[];
    options?: string[];
    onToggle: (option: string) => void;
    ariaLabel: string;
    optionColor?: (option: string) => string;
    /** When true, the menu opens and focuses an option (driven by the grid cell
     *  so a single Enter opens the list). */
    forceOpen?: boolean;
    /** Called when the picker wants to close (Enter/Escape/Tab/outside click) so
     *  the host can hand focus back to the cell for arrow-key navigation. */
    onRequestClose?: () => void;
  } = $props();

  let isOpen = $state(false);
  let containerEl: HTMLDivElement | undefined = $state();
  let chevronEl: HTMLButtonElement | undefined = $state();
  let focusedOptionIndex = $state(0);
  let liveMessage = $state('');
  const uid = Math.random().toString(36).slice(2, 10);
  const listboxId = `multi-picker-listbox-${uid}`;
  const listboxHintId = `multi-picker-listbox-hint-${uid}`;

  let typeaheadBuffer = '';
  let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;

  // Host-driven open: a single Enter on the cell flips forceOpen, which opens the
  // menu and focuses an option. Flipping it back closes the menu.
  let lastForceOpen = false;
  $effect(() => {
    if (forceOpen === lastForceOpen) return;
    lastForceOpen = forceOpen;
    if (forceOpen) void openMenu(true);
    else isOpen = false;
  });

  $effect(() => {
    if (!isOpen) return;
    const el = containerEl!;
    function onDocPointerDown(event: Event) {
      if (el.contains(event.target as Node | null)) return;
      requestClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  });

  function optionEls(): HTMLElement[] {
    return Array.from(containerEl!.querySelectorAll('[role="option"]')) as HTMLElement[];
  }

  function focusOptionAt(index: number) {
    const items = optionEls();
    if (items.length === 0) {
      chevronEl?.focus();
      return;
    }
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    focusedOptionIndex = clamped;
    items[clamped].focus();
  }

  function clearTypeahead() {
    typeaheadBuffer = '';
    if (typeaheadTimer) {
      clearTimeout(typeaheadTimer);
      typeaheadTimer = null;
    }
  }

  async function openMenu(focusFirst = true) {
    isOpen = true;
    if (focusFirst) {
      await tick();
      // Focus the first selected option if any, else the first option, so the
      // user lands somewhere sensible to start toggling.
      const firstSelected = options.findIndex((o) => values.includes(o));
      focusOptionAt(firstSelected >= 0 ? firstSelected : 0);
    }
  }

  // Close and ask the host to return focus to the cell. Used for Enter / Escape
  // / Tab / outside-click — i.e. "done editing this cell".
  function requestClose() {
    isOpen = false;
    clearTypeahead();
    onRequestClose?.();
  }

  function countMessage(count: number): string {
    return `${count} selected`;
  }

  function toggle(option: string) {
    const wasSelected = values.includes(option);
    liveMessage = wasSelected
      ? `${option} removed. ${countMessage(Math.max(0, values.length - 1))}.`
      : `${option} added. ${countMessage(values.length + 1)}.`;
    onToggle(option);
  }

  function handleTriggerClick(event: MouseEvent) {
    if (event.target instanceof HTMLElement && event.target.closest('.multi-picker-chevron-btn')) return;
    if (isOpen) requestClose();
    else void openMenu(false);
  }

  function handleChevronClick() {
    if (isOpen) requestClose();
    else void openMenu();
  }

  async function handleChevronKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isOpen) await openMenu();
      else focusOptionAt(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) await openMenu(false);
      const items = optionEls();
      if (items.length > 0) focusOptionAt(items.length - 1);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      requestClose();
    }
  }

  function applyTypeahead(char: string) {
    const lower = char.toLowerCase();
    const repeatingSameLetter =
      typeaheadBuffer.length > 0 && typeaheadBuffer.split('').every((c) => c === lower);
    typeaheadBuffer = repeatingSameLetter ? lower : typeaheadBuffer + lower;
    if (typeaheadTimer) clearTimeout(typeaheadTimer);
    typeaheadTimer = setTimeout(() => {
      typeaheadBuffer = '';
      typeaheadTimer = null;
    }, 500);
    const items = optionEls();
    if (items.length === 0) return;
    const currentIdx = items.findIndex((it) => it === document.activeElement);
    const start =
      typeaheadBuffer.length === 1 ? (currentIdx + 1) % items.length : Math.max(0, currentIdx);
    for (let i = 0; i < items.length; i++) {
      const idx = (start + i) % items.length;
      const label = (items[idx].textContent ?? '').trim().toLowerCase();
      if (label.startsWith(typeaheadBuffer)) {
        focusOptionAt(idx);
        return;
      }
    }
  }

  function handleOptionKeydown(event: KeyboardEvent, option: string) {
    // Space toggles selection (stay open for more); Enter is "done" → close.
    if (event.key === ' ') {
      event.preventDefault();
      toggle(option);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      requestClose();
    }
  }

  function handleMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      requestClose();
      return;
    }
    const items = optionEls();
    if (items.length === 0) return;
    const current = items.findIndex((it) => it === document.activeElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusOptionAt((current + 1) % items.length);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusOptionAt((current - 1 + items.length) % items.length);
        return;
      case 'Home':
        event.preventDefault();
        focusOptionAt(0);
        return;
      case 'End':
        event.preventDefault();
        focusOptionAt(items.length - 1);
        return;
    }
    if (
      event.key.length === 1 &&
      /\S/.test(event.key) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      applyTypeahead(event.key);
    }
  }

  const colorCache = new Map<string, string>();

  function parseColor(input: string): [number, number, number] | null {
    const s = input.trim();
    const hex = /^#([0-9a-fA-F]{3,8})$/.exec(s);
    if (hex) {
      const h = hex[1];
      if (h.length === 3) {
        return [
          parseInt(h[0] + h[0], 16),
          parseInt(h[1] + h[1], 16),
          parseInt(h[2] + h[2], 16),
        ];
      }
      if (h.length === 6 || h.length === 8) {
        return [
          parseInt(h.slice(0, 2), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16),
        ];
      }
    }
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
    if (rgb) {
      return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
    }
    if (typeof document !== 'undefined') {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#000';
          ctx.fillStyle = s;
          const out = ctx.fillStyle;
          if (typeof out === 'string') {
            const m = /^#([0-9a-f]{6})$/i.exec(out);
            if (m) {
              return [
                parseInt(m[1].slice(0, 2), 16),
                parseInt(m[1].slice(2, 4), 16),
                parseInt(m[1].slice(4, 6), 16),
              ];
            }
          }
        }
      } catch {
        /* canvas unsupported or invalid color — fall through */
      }
    }
    return null;
  }

  function pickTextColor(bg: string): string {
    const cached = colorCache.get(bg);
    if (cached !== undefined) return cached;
    const rgb = parseColor(bg);
    if (!rgb) {
      colorCache.set(bg, 'inherit');
      return 'inherit';
    }
    const linear = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
    const color = L > 0.5 ? '#1a1a1a' : '#ffffff';
    colorCache.set(bg, color);
    return color;
  }

  // Selected options are painted in their colour; unselected ones get a faint
  // tint of it so the two states are clearly distinct in the one list.
  function styleFor(option: string, selected: boolean): string | undefined {
    if (!optionColor) return undefined;
    const bg = optionColor(option);
    if (selected) {
      const fg = pickTextColor(bg);
      return `background:${bg};color:${fg}`;
    }
    return `background:color-mix(in oklab, ${bg} 18%, transparent);color:var(--text)`;
  }
</script>

<div class="multi-picker" bind:this={containerEl}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="multi-picker-trigger" onclick={handleTriggerClick}>
    <div class="multi-picker-values">
      {#if values.length}
        {#each values as value (value)}
          <span class="multi-picker-pill" style={styleFor(value, true)}>{value}</span>
        {/each}
      {:else}
        <span class="multi-picker-placeholder">None</span>
      {/if}
    </div>
    <button
      type="button"
      class="multi-picker-chevron-btn"
      aria-haspopup="listbox"
      aria-expanded={isOpen}
      aria-controls={isOpen ? listboxId : undefined}
      aria-label={isOpen ? `Close ${ariaLabel.toLowerCase()} picker` : `Open ${ariaLabel.toLowerCase()} picker`}
      bind:this={chevronEl}
      onclick={handleChevronClick}
      onkeydown={handleChevronKeydown}
    >
      <span class="multi-picker-chevron" aria-hidden="true">▾</span>
    </button>
  </div>
  {#if isOpen}
    <div
      class="multi-picker-menu"
      id={listboxId}
      role="listbox"
      aria-multiselectable="true"
      aria-label={`Choose ${ariaLabel.toLowerCase()}`}
      aria-describedby={listboxHintId}
      tabindex="-1"
      onkeydown={handleMenuKeydown}
    >
      {#each options as option, i (option)}
        {@const selected = values.includes(option)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="multi-picker-option"
          class:selected
          role="option"
          aria-selected={selected}
          tabindex={i === focusedOptionIndex ? 0 : -1}
          style={styleFor(option, selected)}
          onclick={() => toggle(option)}
          onkeydown={(e) => handleOptionKeydown(e, option)}
        >
          <span class="multi-picker-check" aria-hidden="true">{selected ? '✓' : ''}</span>
          {option}
        </div>
      {:else}
        <span class="multi-picker-empty">No options</span>
      {/each}
    </div>
  {/if}
  <span id={listboxHintId} class="visually-hidden">
    Use arrow keys to move between options. Press Space to add or remove the focused option. Press Enter or Escape when done. Type a letter to jump to a matching option.
  </span>
  <div class="visually-hidden" aria-live="polite" aria-atomic="true">{liveMessage}</div>
</div>

<style>
  .multi-picker {
    position: relative;
    width: 100%;
  }

  .multi-picker-trigger {
    font: inherit;
    width: 100%;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, var(--surface) 60%);
    border-radius: 8px;
    padding: 0.22rem 0.35rem;
    background: color-mix(in oklab, var(--bgTint) 12%, var(--surface) 88%);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 1.9rem;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .multi-picker-values {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    min-width: 0;
    flex: 1 1 auto;
  }

  .multi-picker-pill {
    border-radius: 999px;
    padding: 0.2rem 0.55rem;
    min-height: 1.5rem;
    display: inline-flex;
    align-items: center;
    font-size: 0.85rem;
    color: var(--text);
    white-space: normal;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
  }

  .multi-picker-placeholder {
    color: color-mix(in oklab, var(--text) 55%, transparent 45%);
  }

  .multi-picker-chevron-btn {
    flex: 0 0 auto;
    background: transparent;
    border: 0;
    padding: 0.25rem 0.35rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    border-radius: 4px;
    min-height: 1.5rem;
    color: color-mix(in oklab, var(--cardBorder) 62%, var(--text) 38%);
  }

  .multi-picker-chevron-btn:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--cardBorder) 60%, var(--text) 40%);
    outline-offset: 1px;
  }

  .multi-picker-chevron {
    font-size: 0.8rem;
    line-height: 1;
  }

  .multi-picker-menu {
    position: absolute;
    left: 0;
    top: calc(100% + 0.22rem);
    min-width: 100%;
    width: max-content;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 44%, var(--surface) 56%);
    border-radius: 8px;
    background: color-mix(in oklab, var(--bgTint) 14%, var(--surface) 86%);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.16);
    text-align: left;
    box-sizing: border-box;
    max-height: 14rem;
    overflow: auto;
  }

  .multi-picker-option {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font: inherit;
    border: 0;
    border-radius: 999px;
    padding: 0.25rem 0.6rem;
    min-height: 1.6rem;
    font-size: 0.95rem;
    color: var(--text);
    white-space: nowrap;
    cursor: pointer;
    /* Unselected options read as "outlined", selected as "filled" — reinforced
       by the colour fill from styleFor and the check mark. */
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  }

  .multi-picker-option.selected {
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28);
    font-weight: 600;
  }

  .multi-picker-option:hover,
  .multi-picker-option:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--cardBorder) 60%, var(--text) 40%);
    outline-offset: 1px;
  }

  .multi-picker-check {
    display: inline-grid;
    place-items: center;
    width: 0.9em;
    font-size: 0.85em;
    font-weight: 800;
  }

  .multi-picker-empty {
    color: color-mix(in oklab, var(--text) 55%, transparent 45%);
    font-size: 0.9rem;
    padding: 0.1rem 0.2rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>

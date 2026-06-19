<script lang="ts">
  import { tick } from 'svelte';
  import { drugDisplayColor, drugInitial } from '$lib/utils/pharmacokinetics';
  import { floatingMenu } from '$lib/grid/floatingMenu';

  type Vial = { id: number; dbId: string; type: string };

  let {
    prescriptionId = undefined,
    autoVialDbId = undefined,
    medication = '',
    vials = [],
    drugOptions = [],
    ariaLabel,
    forceOpen = false,
    vialSelected = false,
    onActivate,
    onRequestClose,
    onPickVial,
    onPickDrug,
    onClear,
  }: {
    prescriptionId?: string;
    /** Vial the FIFO system auto-attributes this dose to (no manual override). */
    autoVialDbId?: string;
    medication?: string;
    vials?: Vial[];
    drugOptions?: string[];
    ariaLabel: string;
    /** Host-driven open (the grid cell opens it on a single Enter). */
    forceOpen?: boolean;
    /** The grid selector is currently on this chip → show it highlighted. */
    vialSelected?: boolean;
    /** Chip clicked — let the host move the selection here (and open). */
    onActivate?: () => void;
    /** Called when the picker wants to close so the host can return focus. */
    onRequestClose?: () => void;
    onPickVial: (dbId: string, type: string) => void;
    onPickDrug: (medication: string) => void;
    onClear: () => void;
  } = $props();

  let isOpen = $state(false);
  let containerEl: HTMLDivElement | undefined = $state();
  let triggerEl: HTMLButtonElement | undefined = $state();
  let focusedIndex = $state(0);

  const hasVials = $derived(vials.length > 0);
  const overrideVial = $derived(
    prescriptionId ? vials.find((v) => v.dbId === prescriptionId) : undefined,
  );
  // The vial FIFO picked for this dose when there's no manual override — shown so
  // the user can see (and judge whether to change) the system's choice.
  const autoVial = $derived(
    !overrideVial && autoVialDbId ? vials.find((v) => v.dbId === autoVialDbId) : undefined,
  );
  // Collapsed label: '#N' for the chosen vial (override OR auto), the drug
  // initial when no vial is resolved, or a bare vial glyph when nothing's set.
  // Kept to ~1ch so the column never grows.
  const chipMedication = $derived(overrideVial?.type || autoVial?.type || medication);
  const chipColor = $derived(chipMedication ? drugDisplayColor(chipMedication) : 'var(--cardBorder)');
  // The dose's vial — its stored attribution, or the just-picked auto one before
  // it's frozen. Rendered identically either way (every dose maps to one vial).
  const chipVial = $derived(overrideVial ?? autoVial);
  const chipText = $derived(
    chipVial ? `#${chipVial.id}` : chipMedication ? drugInitial(chipMedication) : '',
  );

  function drugShort(med: string): string {
    return med.split('(')[0]?.trim() || med;
  }

  let lastForceOpen = false;
  $effect(() => {
    if (forceOpen === lastForceOpen) return;
    lastForceOpen = forceOpen;
    if (forceOpen) void open();
    else isOpen = false;
  });

  function optionEls(): HTMLElement[] {
    return containerEl ? (Array.from(containerEl.querySelectorAll('[role="option"]')) as HTMLElement[]) : [];
  }

  function selectedOptionIndex(): number {
    const items = optionEls();
    const idx = items.findIndex((el) => el.getAttribute('aria-selected') === 'true');
    return idx >= 0 ? idx : 0;
  }

  function focusOptionAt(index: number) {
    const items = optionEls();
    if (items.length === 0) return;
    const clamped = ((index % items.length) + items.length) % items.length;
    focusedIndex = clamped;
    items[clamped].focus();
  }

  async function open() {
    isOpen = true;
    await tick();
    focusOptionAt(selectedOptionIndex());
  }

  function requestClose() {
    isOpen = false;
    onRequestClose?.();
  }

  function pickVial(v: Vial) {
    onPickVial(v.dbId, v.type);
    requestClose();
  }

  function pickDrug(med: string) {
    onPickDrug(med);
    requestClose();
  }

  function clear() {
    onClear();
    requestClose();
  }

  function handleFocusout(event: FocusEvent) {
    const next = event.relatedTarget;
    const current = event.currentTarget;
    if (current instanceof HTMLElement && (!(next instanceof Node) || !current.contains(next))) {
      requestClose();
    }
  }

  function handleChipKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!isOpen) void open();
      else focusOptionAt(event.key === 'ArrowUp' ? optionEls().length - 1 : 0);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    }
  }

  // Arrow/Home/End move focus between options; Escape/Tab close. Enter/Space are
  // left to the native <button> (their click handler performs the selection).
  // stopPropagation throughout so keys never bubble to the grid cell handler.
  function handleOptionKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        focusOptionAt(focusedIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        focusOptionAt(focusedIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        focusOptionAt(0);
        return;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        focusOptionAt(optionEls().length - 1);
        return;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      case 'Enter':
      case ' ':
        event.stopPropagation();
        return;
    }
  }
</script>

<div class="vial-picker" bind:this={containerEl} onfocusout={handleFocusout}>
  <button
    type="button"
    class="vial-chip"
    class:placeholder={!chipText}
    class:selected={vialSelected}
    style={`--chip-color:${chipColor}`}
    aria-haspopup="listbox"
    aria-expanded={isOpen}
    aria-label={ariaLabel}
    bind:this={triggerEl}
    title={chipVial ? `Vial #${chipVial.id} — click to change` : chipMedication || 'Pick vial / drug'}
    onclick={(e) => { e.stopPropagation(); if (isOpen) requestClose(); else if (onActivate) onActivate(); else void open(); }}
    onkeydown={handleChipKeydown}
  >
    {#if chipText}
      <span class="vial-chip-label">{chipText}</span>
    {:else}
      <svg viewBox="0 0 16 16" aria-hidden="true" class="vial-glyph"
        ><path
          d="M6 1.5h4M6.8 2v4.2L4.4 11a2 2 0 0 0 1.8 2.9h3.6A2 2 0 0 0 11.6 11L9.2 6.2V2"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        /></svg
      >
    {/if}
  </button>

  {#if isOpen}
    <div
      class="vial-menu"
      role="listbox"
      aria-label={ariaLabel}
      use:floatingMenu={{ anchor: triggerEl, matchAnchorWidth: false }}
    >
      {#if hasVials}
        <button
          type="button"
          class:selected={!prescriptionId}
          role="option"
          aria-selected={!prescriptionId}
          tabindex="-1"
          onclick={(e) => { e.stopPropagation(); clear(); }}
          onkeydown={handleOptionKeydown}
        >Auto (based on vial order)</button>
        {#each vials as v (v.dbId)}
          <button
            type="button"
            class:selected={v.dbId === prescriptionId}
            role="option"
            aria-selected={v.dbId === prescriptionId}
            tabindex="-1"
            onclick={(e) => { e.stopPropagation(); pickVial(v); }}
            onkeydown={handleOptionKeydown}
          >
            <span class="vial-num" style={`--chip-color:${drugDisplayColor(v.type)}`}>#{v.id}</span>
            <span class="vial-name">{drugShort(v.type) || 'Unset'}</span>
          </button>
        {/each}
      {:else}
        {#each drugOptions as med (med)}
          <button
            type="button"
            class:selected={med === medication}
            role="option"
            aria-selected={med === medication}
            tabindex="-1"
            onclick={(e) => { e.stopPropagation(); pickDrug(med); }}
            onkeydown={handleOptionKeydown}
          >
            <span class="vial-num" style={`--chip-color:${drugDisplayColor(med)}`}>{drugInitial(med)}</span>
            <span class="vial-name">{drugShort(med)}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .vial-picker {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
  }

  .vial-chip {
    display: inline-grid;
    place-items: center;
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 0.25rem;
    border: 1px solid color-mix(in oklab, var(--chip-color) 55%, transparent);
    border-radius: 999px;
    background: color-mix(in oklab, var(--chip-color) 16%, var(--surface) 84%);
    color: color-mix(in oklab, var(--chip-color) 75%, var(--text) 25%);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 800;
    line-height: 1;
    cursor: pointer;
  }

  .vial-chip.placeholder {
    color: color-mix(in oklab, var(--text) 55%, transparent);
    background: transparent;
  }

  /* Highlight when the grid selector is on the chip. */
  .vial-chip.selected {
    box-shadow:
      0 0 0 2px var(--surface),
      0 0 0 4px var(--accent);
  }

  .vial-glyph {
    width: 0.85rem;
    height: 0.85rem;
  }

  /* Positioned (fixed, anchored to the chip) by the floatingMenu action so it
     escapes `.table-scroll`'s overflow clip; left/top are set inline. */
  .vial-menu {
    z-index: 50;
    min-width: max-content;
    max-width: min(18rem, 80vw);
    max-height: 12rem;
    overflow: auto;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 44%, transparent);
    border-radius: 8px;
    background: color-mix(in oklab, var(--bgTint) 14%, var(--surface) 86%);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.16);
    text-align: left;
  }

  .vial-menu button {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    border: 0;
    padding: 0.3rem 0.5rem;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .vial-menu button:hover,
  .vial-menu button:focus-visible,
  .vial-menu button.selected {
    background: color-mix(in oklab, var(--accent) 14%, var(--surface) 86%);
    outline: none;
  }

  .vial-num {
    display: inline-grid;
    place-items: center;
    min-width: 1.3em;
    height: 1.3em;
    padding: 0 0.25em;
    border-radius: 999px;
    background: var(--chip-color);
    color: white;
    font-size: 0.74em;
    font-weight: 800;
    line-height: 1;
  }
</style>

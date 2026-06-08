<script lang="ts">
  import { tick } from 'svelte';

  let {
    value = '',
    options = [],
    onSelect,
    ariaLabel,
    invalid = false,
    forceOpen = false,
    onRequestClose,
  }: {
    value?: string;
    options?: string[];
    onSelect: (value: string) => void;
    ariaLabel: string;
    invalid?: boolean;
    /** Host-driven open (the grid cell opens it on a single Enter). */
    forceOpen?: boolean;
    /** Called when the picker wants to close so the host can return focus. */
    onRequestClose?: () => void;
  } = $props();

  let isOpen = $state(false);
  let containerEl: HTMLDivElement | undefined = $state();
  let triggerEl: HTMLButtonElement | undefined = $state();
  let focusedIndex = $state(0);

  function optionLabel(option: string): string {
    return option || 'None';
  }

  let lastForceOpen = false;
  $effect(() => {
    if (forceOpen === lastForceOpen) return;
    lastForceOpen = forceOpen;
    if (forceOpen) void open(true);
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
    if (items.length === 0) return;
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    focusedIndex = clamped;
    items[clamped].focus();
  }

  async function open(focusOption = true) {
    isOpen = true;
    if (focusOption) {
      await tick();
      const selected = options.indexOf(value);
      focusOptionAt(selected >= 0 ? selected : 0);
    }
  }

  function requestClose() {
    isOpen = false;
    onRequestClose?.();
  }

  function choose(option: string) {
    onSelect(option);
    requestClose();
  }

  async function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isOpen) await open();
      else focusOptionAt(event.key === 'ArrowUp' ? optionEls().length - 1 : 0);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      requestClose();
    }
  }

  function handleOptionKeydown(event: KeyboardEvent, option: string) {
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(option);
        return;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        requestClose();
        return;
      case 'ArrowDown':
        event.preventDefault();
        focusOptionAt((focusedIndex + 1) % optionEls().length);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusOptionAt((focusedIndex - 1 + optionEls().length) % optionEls().length);
        return;
      case 'Home':
        event.preventDefault();
        focusOptionAt(0);
        return;
      case 'End':
        event.preventDefault();
        focusOptionAt(optionEls().length - 1);
        return;
    }
    if (event.key.length === 1 && /\S/.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const lower = event.key.toLowerCase();
      const items = optionEls();
      const start = (focusedIndex + 1) % items.length;
      for (let i = 0; i < items.length; i++) {
        const idx = (start + i) % items.length;
        if ((items[idx].textContent ?? '').trim().toLowerCase().startsWith(lower)) {
          event.preventDefault();
          focusOptionAt(idx);
          return;
        }
      }
    }
  }
</script>

<div class="custom-picker" bind:this={containerEl}>
  <!-- tabindex -1: the picker lives inside a grid cell whose <td> is the single
       tab stop. Tab lands on the cell (arrows navigate the grid, Enter opens via
       forceOpen); the trigger is reached by click or by the cell opening it, not
       by Tab. -->
  <button
    type="button"
    class="custom-picker-trigger"
    class:invalid
    tabindex={-1}
    aria-haspopup="listbox"
    aria-expanded={isOpen}
    aria-label={ariaLabel}
    bind:this={triggerEl}
    onclick={() => (isOpen ? requestClose() : open())}
    onkeydown={handleTriggerKeydown}
  >
    <span>{optionLabel(value)}</span>
    <span class="custom-picker-chevron" aria-hidden="true">▾</span>
  </button>
  {#if isOpen}
    <div class="custom-picker-menu" role="listbox" aria-label={ariaLabel}>
      {#each options as option, i (option)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="custom-picker-option"
          class:selected={option === value}
          role="option"
          aria-selected={option === value}
          tabindex={i === focusedIndex ? 0 : -1}
          onclick={() => choose(option)}
          onkeydown={(e) => handleOptionKeydown(e, option)}
        >
          {optionLabel(option)}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .custom-picker {
    position: relative;
    width: 100%;
  }

  .custom-picker-trigger,
  .custom-picker-menu div {
    font: inherit;
  }

  .custom-picker-trigger {
    width: 100%;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, transparent);
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

  .custom-picker-trigger.invalid {
    border-color: var(--warning);
    color: color-mix(in oklab, var(--warning) 70%, var(--text) 30%);
    background: color-mix(in oklab, var(--warning) 14%, var(--surface) 86%);
  }

  .custom-picker-chevron {
    flex: 0 0 auto;
    color: color-mix(in oklab, var(--cardBorder) 62%, var(--text) 38%);
    font-size: 0.8rem;
    line-height: 1;
  }

  .custom-picker-menu {
    position: absolute;
    left: 0;
    top: calc(100% + 0.22rem);
    min-width: 100%;
    width: max-content;
    max-width: min(20rem, 90vw);
    z-index: 10;
    max-height: 12rem;
    overflow: auto;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 44%, transparent);
    border-radius: 8px;
    background: color-mix(in oklab, var(--bgTint) 14%, var(--surface) 86%);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.16);
    text-align: left;
    box-sizing: border-box;
  }

  .custom-picker-option {
    padding: 0.28rem 0.45rem;
    color: var(--text);
    cursor: pointer;
  }

  .custom-picker-option:hover,
  .custom-picker-option:focus-visible,
  .custom-picker-option.selected {
    background: color-mix(in oklab, var(--accent) 14%, var(--surface) 86%);
    outline: none;
  }
</style>

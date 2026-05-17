<script lang="ts">
  let {
    value = '',
    options = [],
    onSelect,
    ariaLabel,
    invalid = false,
  }: {
    value?: string;
    options?: string[];
    onSelect: (value: string) => void;
    ariaLabel: string;
    invalid?: boolean;
  } = $props();

  let isOpen = $state(false);

  function optionLabel(option: string): string {
    return option || 'None';
  }

  function chooseOption(option: string) {
    onSelect(option);
    isOpen = false;
  }

  function handleFocusout(event: FocusEvent) {
    const relatedTarget = event.relatedTarget;
    const currentTarget = event.currentTarget;
    if (
      currentTarget instanceof HTMLElement &&
      (!(relatedTarget instanceof Node) || !currentTarget.contains(relatedTarget))
    ) {
      isOpen = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      isOpen = false;
      return;
    }

    if (event.key === ' ') {
      event.preventDefault();
      isOpen = !isOpen;
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    event.preventDefault();
    if (options.length === 0) {
      isOpen = true;
      return;
    }

    const currentIndex = Math.max(options.indexOf(value), 0);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    chooseOption(options[nextIndex]);
  }
</script>

<div class="custom-picker" onfocusout={handleFocusout}>
  <button
    type="button"
    class="custom-picker-trigger"
    class:invalid
    aria-haspopup="listbox"
    aria-expanded={isOpen}
    aria-label={ariaLabel}
    onclick={() => (isOpen = !isOpen)}
    onkeydown={handleKeydown}
  >
    <span>{optionLabel(value)}</span>
    <span class="custom-picker-chevron" aria-hidden="true">▾</span>
  </button>
  {#if isOpen}
    <div class="custom-picker-menu" role="listbox" aria-label={ariaLabel}>
      {#each options as option (option)}
        <button
          type="button"
          class:selected={option === value}
          role="option"
          aria-selected={option === value}
          onclick={() => chooseOption(option)}
        >
          {optionLabel(option)}
        </button>
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
  .custom-picker-menu button {
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
    max-height: 11rem;
    overflow: auto;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 44%, transparent);
    border-radius: 8px;
    background: color-mix(in oklab, var(--bgTint) 14%, var(--surface) 86%);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.16);
    text-align: left;
    box-sizing: border-box;
  }

  .custom-picker-menu button {
    width: 100%;
    border: 0;
    border-radius: 0;
    padding: 0.28rem 0.45rem;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .custom-picker-menu button:hover,
  .custom-picker-menu button:focus-visible,
  .custom-picker-menu button.selected {
    background: color-mix(in oklab, var(--accent) 14%, var(--surface) 86%);
    outline: none;
  }
</style>

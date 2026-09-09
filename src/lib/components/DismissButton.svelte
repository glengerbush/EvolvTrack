<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';

  let {
    ariaLabel,
    title = 'Dismiss',
    onclick,
  }: {
    ariaLabel: string;
    title?: string;
    onclick?: HTMLButtonAttributes['onclick'];
  } = $props();
</script>

<button class="dismiss-button" type="button" aria-label={ariaLabel} {title} {onclick}>
  <CloseIcon size="1rem" />
</button>

<style>
  .dismiss-button {
    appearance: none;
    -webkit-appearance: none;
    position: relative;
    flex: 0 0 auto;
    box-sizing: border-box;
    width: 2.25rem;
    height: 2.25rem;
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm, 10px);
    background: transparent;
    color: inherit;
    cursor: pointer;
    touch-action: manipulation;
  }

  /* Keep a 44px touch target without forcing compact banners and card headers
     to grow around a 44px visible control. */
  .dismiss-button::before {
    content: '';
    position: absolute;
    inset: -0.25rem;
  }

  .dismiss-button:hover,
  .dismiss-button:focus-visible {
    background: color-mix(in oklab, currentColor 12%, transparent);
  }

  .dismiss-button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>

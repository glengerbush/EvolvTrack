<script lang="ts">
  let {
    size = '100%',
    color = 'currentColor',
    active = false
  }: {
    size?: string;
    color?: string;
    active?: boolean;
  } = $props();
</script>

<span class="edit-pencil-icon" aria-hidden="true" style={`--icon-size:${size}; --icon-color:${color};`}>
  {#if active}
    <svg viewBox="0 0 17.54 17.54" role="presentation" focusable="false">
      <path
        fill="currentColor"
        fill-rule="evenodd"
        d="M2 0H11.2L17.54 6.34V15.54C17.54 16.64 16.64 17.54 15.54 17.54H2C0.9 17.54 0 16.64 0 15.54V2C0 0.9 0.9 0 2 0Z M4 2H12.5V6H4Z M3.2 9.2H14V15.2H3.2Z M8.77 10.6A1.6 1.6 0 1 0 8.77 13.8A1.6 1.6 0 1 0 8.77 10.6 M8.77 11.7A0.5 0.5 0 1 1 8.77 12.7A0.5 0.5 0 1 1 8.77 11.7"
      />
      <rect x="10.8" y="2.5" width="2.2" height="3" rx="0.4" fill="currentColor" />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" role="presentation" focusable="false">
      <path d="M3 17.25V21h3.75l11-11-3.75-3.75-11 11Zm15.71-8.04 1.83-1.83a1 1 0 0 0 0-1.41L18.03 3.46a1 1 0 0 0-1.41 0l-1.83 1.83 3.92 3.92Z"></path>
    </svg>
  {/if}
</span>

<style>
  .edit-pencil-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-size);
    height: var(--icon-size);
    color: var(--icon-color);
    line-height: 0;
  }

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }
</style>

<script lang="ts">
  let {
    size = '100%',
    color = 'currentColor'
  }: {
    size?: string;
    color?: string;
  } = $props();
</script>

<span class="edit-pencil-icon" aria-hidden="true" style={`--icon-size:${size}; --icon-color:${color};`}>
  <svg viewBox="0 0 24 24" role="presentation" focusable="false">
    <path d="M3 17.25V21h3.75l11-11-3.75-3.75-11 11Zm15.71-8.04 1.83-1.83a1 1 0 0 0 0-1.41L18.03 3.46a1 1 0 0 0-1.41 0l-1.83 1.83 3.92 3.92Z"></path>
  </svg>
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

<script lang="ts">
  let {
    size = '100%',
    color = 'currentColor',
  }: {
    size?: string;
    color?: string;
  } = $props();
</script>

<span class="gear-icon" aria-hidden="true" style={`--icon-size:${size}; --icon-color:${color};`}>
  <svg viewBox="0 0 24 24" role="presentation" focusable="false">
    <path
      d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.35 7.35 0 0 0-1.69-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42L9.12 5.07c-.61.24-1.18.57-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.02.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.31.61.22l2.49-1c.51.4 1.08.74 1.69.98l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.61-.24 1.18-.57 1.69-.98l2.49 1c.22.09.48 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7Z"
    />
  </svg>
</span>

<style>
  .gear-icon {
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

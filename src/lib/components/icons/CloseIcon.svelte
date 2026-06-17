<script lang="ts">
  // "X" / close icon — used for the per-card Cancel button.
  let { size = '1em', color = 'currentColor' }: { size?: string; color?: string } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  role="presentation"
  focusable="false"
  aria-hidden="true"
  style={`width:${size};height:${size};color:${color}`}
>
  <path
    fill="currentColor"
    d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41 6.3 6.3-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"
  />
</svg>

<style>
  svg {
    display: block;
  }
</style>

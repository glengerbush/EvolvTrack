<script lang="ts">
  // Trash-can icon. Same outline path used by the inputs-table gutter delete
  // button (can be refined later); reused for the per-card Delete action.
  let { size = '1em', color = 'currentColor' }: { size?: string; color?: string } = $props();
</script>

<svg
  viewBox="0 0 16 16"
  role="presentation"
  focusable="false"
  aria-hidden="true"
  style={`width:${size};height:${size};color:${color}`}
>
  <path
    d="M2.6 4.2h10.8M6.4 4.2V2.9a.7.7 0 0 1 .7-.7h1.8a.7.7 0 0 1 .7.7v1.3M4.6 4.2l.6 8.5a1.1 1.1 0 0 0 1.1 1h3.4a1.1 1.1 0 0 0 1.1-1l.6-8.5M6.7 6.6v4.6M9.3 6.6v4.6"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>

<style>
  svg {
    display: block;
  }
</style>

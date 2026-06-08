<script lang="ts">
  // Archive icon — an outline "box for paper" (lid + body + slot), like the
  // archive control in email clients.
  let { size = '1em', color = 'currentColor' }: { size?: string; color?: string } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  role="presentation"
  focusable="false"
  aria-hidden="true"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  style={`width:${size};height:${size};color:${color}`}
>
  <rect x="3" y="4" width="18" height="4" rx="1" />
  <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
  <path d="M10 12h4" />
</svg>

<style>
  svg {
    display: block;
  }
</style>

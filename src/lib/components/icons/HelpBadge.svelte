<script lang="ts">
  let {
    size = '1.1rem',
    tooltip,
  }: {
    size?: string;
    tooltip?: string;
  } = $props();
</script>

<span
  class="help-badge"
  style={`--badge-size:${size};`}
  title={tooltip}
  aria-label={tooltip}
  role={tooltip ? 'img' : undefined}
  aria-hidden={tooltip ? undefined : 'true'}
>?</span>

<style>
  .help-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--badge-size);
    height: var(--badge-size);
    border-radius: 999px;
    background: color-mix(in oklab, currentColor 18%, transparent);
    color: inherit;
    font-size: calc(var(--badge-size) * 0.72);
    font-weight: 700;
    line-height: 1;
  }
</style>

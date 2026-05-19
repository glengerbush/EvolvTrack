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
  class="warn-badge"
  style={`--badge-size:${size};`}
  title={tooltip}
  aria-label={tooltip}
  role={tooltip ? 'img' : undefined}
  aria-hidden={tooltip ? undefined : 'true'}
>⚠</span>

<style>
  .warn-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--badge-size);
    height: var(--badge-size);
    border-radius: 999px;
    background: var(--warning);
    color: var(--headerText);
    font-size: calc(var(--badge-size) * 0.68);
    font-weight: 700;
    line-height: 1;
    /* ⚠ glyph sits low in its em-box; nudge up so it looks centered */
    transform: translateY(-2px);
  }
</style>

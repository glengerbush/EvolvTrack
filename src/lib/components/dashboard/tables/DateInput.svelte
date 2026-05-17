<script lang="ts">
  let {
    value = $bindable(''),
    onchange,
  }: {
    value?: string;
    onchange?: (value: string) => void;
  } = $props();

  function handle(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    value = v;
    onchange?.(v);
  }
</script>

<input type="date" {value} oninput={handle} onchange={handle} />

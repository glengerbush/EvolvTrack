<script lang="ts">
  let {
    value = $bindable(''),
    onchange,
    onkeydown,
    onblur,
  }: {
    value?: string;
    onchange?: (value: string) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onblur?: (e: FocusEvent) => void;
  } = $props();

  function handle(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    value = v;
    onchange?.(v);
  }
</script>

<input type="date" {value} oninput={handle} onchange={handle} {onkeydown} {onblur} />

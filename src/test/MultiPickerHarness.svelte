<script lang="ts">
  import MultiPicker from '$lib/components/dashboard/tables/MultiPicker.svelte';

  let {
    initialValues = [],
    options = [],
    optionColor,
    ariaLabel = 'Symptoms',
  }: {
    initialValues?: string[];
    options?: string[];
    optionColor?: (option: string) => string;
    ariaLabel?: string;
  } = $props();

  // svelte-ignore state_referenced_locally — harness intentionally snapshots once
  let values = $state([...initialValues]);

  function onToggle(option: string) {
    if (values.includes(option)) {
      values = values.filter((v) => v !== option);
    } else {
      values = [...values, option];
    }
  }
</script>

<MultiPicker {values} {options} {onToggle} {ariaLabel} {optionColor} />

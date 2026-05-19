<script lang="ts">
  import { DRUG_PK } from '$lib/utils/pharmacokinetics';
  import type { Medication } from '$lib/domain/types';

  let {
    doseCount = 0,
    vialCount = 0,
    onConfirm,
    onCancel,
  }: {
    doseCount?: number;
    vialCount?: number;
    onConfirm: (medication: Medication) => void;
    onCancel: () => void;
  } = $props();

  const options = Object.keys(DRUG_PK) as Medication[];
  let selected = $state<Medication>(options[0]);

  const pieces = $derived.by(() => {
    const parts: string[] = [];
    if (doseCount) parts.push(`${doseCount} dose${doseCount === 1 ? '' : 's'}`);
    if (vialCount) parts.push(`${vialCount} vial${vialCount === 1 ? '' : 's'}`);
    return parts.join(' and ');
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onCancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="modal-backdrop"
  role="presentation"
  onclick={handleBackdropClick}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="import-med-title"
    tabindex="-1"
  >
    <h3 id="import-med-title">Which medication is this?</h3>
    <p>
      Your import has {pieces} with no medication specified.
      EvolvTrack needs to know the drug to calculate the "mg in system" graph. We'll
      assume every dose and vial without a medication used the same one.
    </p>
    <label class="modal-field">
      Medication
      <select bind:value={selected}>
        {#each options as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </label>
    <div class="modal-actions">
      <button type="button" class="ghost" onclick={onCancel}>Skip for now</button>
      <button type="button" class="primary" onclick={() => onConfirm(selected)}>
        Apply to all {pieces}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 1000;
  }

  .modal {
    background: var(--surface);
    color: var(--text);
    border: 3px solid var(--cardBorder);
    border-radius: 12px;
    padding: 1.25rem;
    max-width: 28rem;
    width: 100%;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  }

  .modal h3 {
    margin: 0 0 0.5rem;
  }

  .modal p {
    margin: 0 0 1rem;
    font-size: 0.95rem;
    line-height: 1.4;
  }

  .modal-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .modal-field select {
    font: inherit;
    font-weight: 400;
    padding: 0.35rem 0.4rem;
    border: 2px solid color-mix(in oklab, var(--cardBorder) 60%, white 40%);
    border-radius: 8px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.25rem;
  }

  .modal-actions button {
    font: inherit;
    padding: 0.4rem 0.8rem;
    border-radius: 8px;
    cursor: pointer;
  }

  .modal-actions .ghost {
    background: var(--surface);
    border: 2px solid color-mix(in oklab, var(--cardBorder) 55%, white 45%);
    color: var(--text);
  }

  .modal-actions .primary {
    background: var(--headerBg);
    border: 2px solid var(--cardBorder);
    color: var(--headerText);
  }
</style>

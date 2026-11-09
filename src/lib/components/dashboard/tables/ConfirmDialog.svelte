<script lang="ts">
  import { focusTrap } from '$lib/utils/focusTrap';

  // Small reusable confirmation modal. Markup + styles were lifted from the
  // inline option-delete dialog in InputsTable so the per-card row/vial delete
  // confirmations (and any future ones) share one styled dialog instead of the
  // native `confirm()`.
  let {
    title,
    message,
    confirmLabel = 'Yes',
    cancelLabel = 'Cancel',
    busy = false,
    errorMessage = '',
    onConfirm,
    onCancel,
  }: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    busy?: boolean;
    errorMessage?: string;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  } = $props();

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="confirm-backdrop" role="presentation">
  <div
    class="confirm-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-dialog-title"
    aria-describedby="confirm-dialog-description"
    aria-busy={busy}
    tabindex="-1"
    use:focusTrap
  >
    <h3 id="confirm-dialog-title">{title}</h3>
    <p id="confirm-dialog-description">{message}</p>
    {#if errorMessage}
      <p class="confirm-error" role="alert">{errorMessage}</p>
    {/if}
    <div class="confirm-actions">
      <button type="button" class="confirm-yes" disabled={busy} onclick={onConfirm}>{confirmLabel}</button>
      <button type="button" class="confirm-cancel" disabled={busy} data-initial-focus onclick={onCancel}>{cancelLabel}</button>
    </div>
  </div>
</div>

<style>
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgba(17, 24, 39, 0.38);
  }

  .confirm-dialog {
    width: min(100%, 26rem);
    border: 1px solid color-mix(in oklab, var(--cardBorder) 48%, white 52%);
    border-radius: 12px;
    padding: 1rem;
    background: color-mix(in oklab, var(--surface) 92%, transparent);
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.22);
  }

  .confirm-dialog h3 {
    margin: 0 0 0.45rem;
    font-size: 1.05rem;
  }

  .confirm-dialog p {
    margin: 0;
    line-height: 1.38;
  }

  .confirm-dialog .confirm-error {
    margin-top: 0.7rem;
    color: var(--danger);
    font-weight: 700;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.45rem;
    margin-top: 0.9rem;
  }

  .confirm-actions button {
    border-radius: 8px;
    padding: 0.48rem 0.7rem;
    font-weight: 800;
    cursor: pointer;
  }

  .confirm-actions button:disabled {
    cursor: wait;
    opacity: 0.68;
  }

  .confirm-yes {
    border: 0;
    background: var(--danger);
    color: white;
  }

  .confirm-cancel {
    border: 1.5px solid color-mix(in oklab, var(--cardBorder) 35%, #d4d4d4 65%);
    background: color-mix(in oklab, var(--surface) 82%, transparent);
    color: var(--text);
  }
</style>

<script lang="ts">
  import { recoverWithCode } from '$lib/sync/e2ee-migration';
  import { requestSync } from '$lib/sync/sync-orchestrator';

  let {
    onClose,
    onRecovered,
  }: {
    onClose: () => void;
    onRecovered: (newRecoveryCode: string) => void;
  } = $props();

  let code = $state('');
  let newPassphrase = $state('');
  let confirmPassphrase = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const passphrasesMatch = $derived(!confirmPassphrase || newPassphrase === confirmPassphrase);
  const canSubmit = $derived(
    !busy &&
      code.trim().length > 0 &&
      newPassphrase.length > 0 &&
      newPassphrase === confirmPassphrase,
  );

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onClose();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (busy) return;
    if (event.target === event.currentTarget) onClose();
  }

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    error = null;
    try {
      const result = await recoverWithCode(code, newPassphrase);
      // recoverWithCode always rotates, so a fresh recovery code is in the
      // result. Hand it to the caller so they can present the once-only
      // modal — closing this dialog without showing it would lose it.
      if (!result.recoveryCode) {
        error = result.error ?? 'Recovery completed without issuing a new code. Try again.';
        busy = false;
        return;
      }
      requestSync();
      onRecovered(result.recoveryCode);
    } catch (err) {
      error = (err as Error).message ?? 'Recovery failed.';
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-backdrop" role="presentation" onclick={handleBackdropClick}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="recovery-unlock-title"
    tabindex="-1"
  >
    <h3 id="recovery-unlock-title">Recover with recovery code</h3>
    <p>
      Paste the recovery code you saved when you enabled encryption. We'll use
      it to unlock your data and prompt you to set a new passphrase. Your old
      recovery code stops working after this — a new one will be shown once.
    </p>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label class="modal-field">
        Recovery code
        <textarea
          bind:value={code}
          rows="2"
          autocomplete="off"
          spellcheck="false"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          disabled={busy}
        ></textarea>
      </label>
      <label class="modal-field">
        New passphrase
        <input
          bind:value={newPassphrase}
          type="password"
          autocomplete="new-password"
          placeholder="Choose a new passphrase"
          disabled={busy}
        />
      </label>
      <label class="modal-field">
        Confirm new passphrase
        <input
          bind:value={confirmPassphrase}
          type="password"
          autocomplete="new-password"
          placeholder="Repeat the new passphrase"
          class:mismatch={!passphrasesMatch}
          disabled={busy}
        />
        {#if !passphrasesMatch}
          <span class="field-error">Passphrases do not match</span>
        {/if}
      </label>
      {#if error}
        <p class="field-error" role="alert">{error}</p>
      {/if}
      <div class="modal-actions">
        <button type="button" class="ghost" onclick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" class="primary" disabled={!canSubmit}>
          {busy ? 'Recovering…' : 'Recover'}
        </button>
      </div>
    </form>
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
    border: 1px solid color-mix(in oklab, var(--text) 18%, transparent);
    border-radius: var(--radius-md, 12px);
    padding: 1.25rem;
    max-width: 28rem;
    width: 100%;
    box-shadow: var(--shadow-soft, 0 12px 32px rgba(0, 0, 0, 0.28));
  }

  .modal h3 {
    margin: 0 0 0.5rem;
    color: var(--text);
  }

  .modal p {
    margin: 0 0 1rem;
    font-size: 0.95rem;
    line-height: 1.4;
    color: var(--muted, var(--text));
  }

  .modal-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.65rem;
  }

  .modal-field input,
  .modal-field textarea {
    font: inherit;
    font-weight: 400;
    padding: 0.45rem 0.6rem;
    border: 1px solid color-mix(in oklab, var(--text) 28%, transparent);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    transition: border-color var(--motion-fast, 140ms), box-shadow var(--motion-fast, 140ms);
    resize: vertical;
  }

  .modal-field textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.04em;
  }

  .modal-field input::placeholder,
  .modal-field textarea::placeholder {
    color: color-mix(in oklab, var(--text) 45%, transparent);
  }

  .modal-field input:focus,
  .modal-field textarea:focus {
    outline: none;
    border-color: var(--brand);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand) 25%, transparent);
  }

  .modal-field input.mismatch {
    border-color: var(--accent-orange, #c5682f);
  }

  .field-error {
    color: var(--accent-orange, #c5682f);
    font-size: 0.85rem;
    margin: 0.25rem 0 0;
    font-weight: 400;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .modal-actions button {
    font: inherit;
    font-weight: 600;
    padding: 0.45rem 1rem;
    border-radius: 999px;
    cursor: pointer;
  }

  .modal-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .modal-actions .ghost {
    background: var(--surface);
    border: 1px solid color-mix(in oklab, var(--text) 18%, transparent);
    color: var(--text);
  }

  .modal-actions .primary {
    background: var(--brand);
    border: 1px solid var(--brand);
    color: #fff;
  }
</style>

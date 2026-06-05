<script lang="ts">
  import BackupButton from '$lib/components/settings/BackupButton.svelte';

  let {
    busy = false,
    error = null,
    onConfirm,
    onCancel,
  }: {
    busy?: boolean;
    error?: string | null;
    onConfirm: (currentPassphrase: string, newPassphrase: string) => void;
    onCancel: () => void;
  } = $props();

  let currentPassphrase = $state('');
  let newPassphrase = $state('');
  let newPassphraseConfirm = $state('');

  const match = $derived(!newPassphraseConfirm || newPassphrase === newPassphraseConfirm);
  const canSubmit = $derived(
    !!currentPassphrase && !!newPassphrase && match && !!newPassphraseConfirm && !busy,
  );

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (busy) return;
    if (event.target === event.currentTarget) onCancel();
  }

  function submit() {
    if (!canSubmit) return;
    onConfirm(currentPassphrase, newPassphrase);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-backdrop" role="presentation" onclick={handleBackdropClick}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="change-passphrase-title"
    tabindex="-1"
  >
    <h3 id="change-passphrase-title">Change encryption passphrase</h3>
    <p>
      Sets a new passphrase, re-encrypts every record under a fresh key, and
      issues a new recovery code. Your old passphrase and old recovery code stop
      working once this finishes.
    </p>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label class="modal-field">
        Current passphrase
        <input
          bind:value={currentPassphrase}
          type="password"
          autocomplete="current-password"
          placeholder="Current passphrase"
          disabled={busy}
        />
      </label>
      <label class="modal-field">
        New passphrase
        <input
          bind:value={newPassphrase}
          type="password"
          autocomplete="new-password"
          placeholder="New passphrase"
          disabled={busy}
        />
      </label>
      <label class="modal-field">
        Confirm new passphrase
        <input
          bind:value={newPassphraseConfirm}
          type="password"
          autocomplete="new-password"
          placeholder="Confirm new passphrase"
          class:mismatch={!match}
          disabled={busy}
        />
        {#if !match}<span class="field-error">Passphrases do not match</span>{/if}
      </label>
      {#if error}
        <p class="field-error" role="alert">{error}</p>
      {/if}
      <div class="backup-slot">
        <BackupButton compact />
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost" onclick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" class="primary" disabled={!canSubmit}>
          {busy ? 'Changing…' : 'Change passphrase'}
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
    background: var(--surface, #fff);
    color: var(--text, #111);
    border: 1px solid color-mix(in oklab, var(--text, #111) 18%, transparent);
    border-radius: var(--radius-md, 12px);
    padding: 1.25rem;
    max-width: 26rem;
    width: 100%;
    /* On short viewports (landscape phone, or keyboard up) a tall modal would
     * overflow off-screen past the centred backdrop; cap it and scroll inside.
     * 2rem = the backdrop's 1rem padding top + bottom. */
    max-height: calc(100dvh - 2rem);
    overflow-y: auto;
    box-shadow: var(--shadow-soft, 0 12px 32px rgba(0, 0, 0, 0.28));
  }

  .modal h3 {
    margin: 0 0 0.5rem;
  }

  .modal p {
    margin: 0 0 1rem;
    font-size: 0.95rem;
    line-height: 1.4;
    color: var(--muted, color-mix(in oklab, var(--text, #111) 65%, transparent));
  }

  .modal-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text, #111);
  }

  .modal-field + .modal-field {
    margin-top: 0.75rem;
  }

  .modal-field input {
    font: inherit;
    font-weight: 400;
    padding: 0.45rem 0.6rem;
    border: 1px solid color-mix(in oklab, var(--text, #111) 28%, transparent);
    border-radius: 8px;
    background: var(--surface, #fff);
    color: var(--text, #111);
  }

  .modal-field input:focus {
    outline: none;
    border-color: var(--brand, #1f7a3a);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand, #1f7a3a) 25%, transparent);
  }

  .modal-field input.mismatch {
    border-color: var(--accent-orange, #c5682f);
  }

  .field-error {
    color: var(--accent-orange, #c5682f);
    font-size: 0.85rem;
    margin: 0.35rem 0 0;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.25rem;
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
    background: var(--surface, #fff);
    border: 1px solid color-mix(in oklab, var(--text, #111) 18%, transparent);
    color: var(--text, #111);
  }

  .modal-actions .primary {
    background: var(--brand, #1f7a3a);
    border: 1px solid var(--brand, #1f7a3a);
    color: #fff;
  }

  .backup-slot {
    margin: 0.85rem 0 0;
  }
</style>

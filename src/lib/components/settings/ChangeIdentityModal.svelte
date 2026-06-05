<script lang="ts">
  let {
    currentIdentifier = null,
    busy = false,
    error = null,
    onConfirm,
    onCancel,
  }: {
    currentIdentifier?: string | null;
    busy?: boolean;
    error?: string | null;
    onConfirm: (username: string, email: string) => void;
    onCancel: () => void;
  } = $props();

  let username = $state('');
  let email = $state('');

  const canSubmit = $derived((!!username || !!email) && !busy);

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
    onConfirm(username, email);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-backdrop" role="presentation" onclick={handleBackdropClick}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="change-identity-title"
    tabindex="-1"
  >
    <h3 id="change-identity-title">Change username / email</h3>
    {#if currentIdentifier}
      <p class="current">Currently signed in as <strong>{currentIdentifier}</strong></p>
    {/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label class="modal-field">
        Username
        <input
          bind:value={username}
          type="text"
          autocomplete="username"
          placeholder="New username"
          disabled={busy}
        />
      </label>
      <label class="modal-field">
        Email
        <input
          bind:value={email}
          type="email"
          autocomplete="email"
          placeholder="New email"
          disabled={busy}
        />
      </label>
      {#if error}
        <p class="field-error" role="alert">{error}</p>
      {/if}
      <div class="modal-actions">
        <button type="button" class="ghost" onclick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" class="primary" disabled={!canSubmit}>
          {busy ? 'Updating…' : 'Update account identity'}
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

  .current {
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

  .field-error {
    color: var(--accent-orange, #c5682f);
    font-size: 0.85rem;
    margin: 0.75rem 0 0;
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
</style>

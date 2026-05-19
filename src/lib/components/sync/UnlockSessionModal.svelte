<script lang="ts">
  import { db } from '$lib/db/schema';
  import { decryptRecord, deriveSessionKey } from '$lib/crypto/e2ee';
  import { setSessionKey } from '$lib/sync/session-key';
  import { requestSync } from '$lib/sync/sync-orchestrator';

  let { onClose }: { onClose: () => void } = $props();

  let passphrase = $state('');
  let remember = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

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

  async function verify(keyB64: string): Promise<boolean> {
    // Try decrypting one local encrypted record to confirm the derived key.
    // If there are none locally yet, accept optimistically — the next push/pull
    // will surface a mismatch as a sync error.
    const sample = await db.encrypted.limit(1).first();
    if (!sample) return true;
    try {
      await decryptRecord(keyB64, sample.ciphertext, sample.iv);
      return true;
    } catch {
      return false;
    }
  }

  async function submit() {
    if (!passphrase || busy) return;
    busy = true;
    error = null;
    try {
      const keyB64 = await deriveSessionKey(passphrase);
      const ok = await verify(keyB64);
      if (!ok) {
        error = "That passphrase didn't unlock your encrypted data.";
        busy = false;
        return;
      }
      setSessionKey(keyB64, { persist: remember });
      // Best-effort: ask the browser for persistent storage so it won't
      // evict the cached key under disk pressure. Safe to ignore failures.
      if (remember && typeof navigator !== 'undefined' && navigator.storage?.persist) {
        navigator.storage.persist().catch(() => undefined);
      }
      requestSync();
      onClose();
    } catch (err) {
      error = (err as Error).message ?? 'Could not unlock.';
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
    aria-labelledby="unlock-session-title"
    tabindex="-1"
  >
    <h3 id="unlock-session-title">Unlock encrypted sync</h3>
    <p>
      Your passphrase isn't kept on this device — it's held in memory only and
      cleared whenever this app reloads. Enter it again to resume end-to-end
      encrypted sync.
    </p>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label class="modal-field">
        Passphrase
        <input
          bind:value={passphrase}
          type="password"
          autocomplete="current-password"
          placeholder="Your passphrase"
          disabled={busy}
        />
      </label>
      <label class="remember">
        <input type="checkbox" bind:checked={remember} disabled={busy} />
        <span>
          Trust this device
          <em>Until you Logout, this device will be able to decrypt your data.</em>
        </span>
      </label>
      {#if error}
        <p class="field-error" role="alert">{error}</p>
      {/if}
      <div class="modal-actions">
        <button type="button" class="ghost" onclick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" class="primary" disabled={!passphrase || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
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
    max-width: 26rem;
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
  }

  .modal-field input {
    font: inherit;
    font-weight: 400;
    padding: 0.45rem 0.6rem;
    border: 1px solid color-mix(in oklab, var(--text) 28%, transparent);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    transition: border-color var(--motion-fast, 140ms), box-shadow var(--motion-fast, 140ms);
  }

  .modal-field input::placeholder {
    color: color-mix(in oklab, var(--text) 45%, transparent);
  }

  .modal-field input:focus {
    outline: none;
    border-color: var(--brand);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand) 25%, transparent);
  }

  .remember {
    display: flex;
    gap: 0.55rem;
    align-items: flex-start;
    margin-top: 0.85rem;
    font-size: 0.85rem;
    color: var(--text);
    cursor: pointer;
  }

  .remember input[type='checkbox'] {
    flex-shrink: 0;
    margin-top: 0.15rem;
    accent-color: var(--brand);
    width: 1rem;
    height: 1rem;
  }

  .remember em {
    display: block;
    font-style: normal;
    color: var(--muted, color-mix(in oklab, var(--text) 60%, transparent));
    font-weight: 400;
    line-height: 1.35;
    margin-top: 0.15rem;
  }

  .field-error {
    color: var(--accent-orange, #c5682f);
    font-size: 0.85rem;
    margin: 0.5rem 0 0;
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

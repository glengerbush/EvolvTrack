<script lang="ts">
  import { resolve } from '$app/paths';
  import { derivePassphraseKek, unwrapDek } from '$lib/crypto/e2ee';
  import { setSessionKey } from '$lib/sync/session-key';
  import {
    fetchRemoteWrappedKeys,
    getLocalWrappedKeys,
    saveLocalWrappedKeys,
  } from '$lib/sync/wrapped-keys';
  import { requestSync } from '$lib/sync/sync-orchestrator';
  import { logoutAndClearLocalData } from '$lib/auth/supabase';
  import RecoveryUnlockModal from '$lib/components/sync/RecoveryUnlockModal.svelte';
  import RecoveryCodesModal from '$lib/components/settings/RecoveryCodesModal.svelte';

  // `dismissible` is false when the modal is the app's lock gate: there's no
  // Cancel / Escape / backdrop-close, because the only way past a locked
  // session is to unlock it or log out.
  let { onClose, dismissible = true }: { onClose: () => void; dismissible?: boolean } =
    $props();

  let passphrase = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let recoveryOpen = $state(false);
  let newRecoveryCode = $state<string | null>(null);

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && dismissible && !busy) {
      event.preventDefault();
      onClose();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (!dismissible || busy) return;
    if (event.target === event.currentTarget) onClose();
  }

  async function logOut() {
    if (busy) return;
    busy = true;
    try {
      await logoutAndClearLocalData();
    } finally {
      window.location.href = resolve('/auth');
    }
  }

  function openRecovery() {
    if (busy) return;
    error = null;
    recoveryOpen = true;
  }

  function closeRecovery() {
    recoveryOpen = false;
  }

  function handleRecovered(code: string) {
    recoveryOpen = false;
    // The newly issued recovery code must be shown exactly once. Hold the
    // unlock modal open behind a "save your new code" view; dismissing that
    // closes the whole stack.
    newRecoveryCode = code;
  }

  function acknowledgeNewCode() {
    newRecoveryCode = null;
    onClose();
  }

  async function submit() {
    if (!passphrase || busy) return;
    busy = true;
    error = null;
    try {
      let bundle = await getLocalWrappedKeys();
      if (!bundle) {
        // Fresh device that hasn't cached the bundle yet (orchestrator
        // reconcile usually pre-fetches this, but the user can also open the
        // modal before the first sync cycle runs). Try the server before
        // sending them down the recovery-code path.
        try {
          const remote = await fetchRemoteWrappedKeys();
          if (remote) {
            const { id: _id, ...rest } = remote;
            bundle = await saveLocalWrappedKeys(rest);
          }
        } catch (cause) {
          error = (cause as Error).message ?? 'Could not reach the server to fetch your encrypted key.';
          busy = false;
          return;
        }
      }
      if (!bundle) {
        error = 'No encrypted bundle on the server for this account. Use a recovery code to set up this device.';
        busy = false;
        return;
      }
      const kek = await derivePassphraseKek(passphrase, bundle.passphraseSaltB64, bundle.passphraseIterations);
      let dek: string;
      try {
        dek = await unwrapDek(kek, bundle.passphraseWrapped.ciphertext, bundle.passphraseWrapped.iv);
      } catch {
        error = "That passphrase didn't unlock your encrypted data.";
        busy = false;
        return;
      }
      setSessionKey(dek);
      // Best-effort: ask the browser for persistent storage so it won't
      // evict the cached key under disk pressure. Safe to ignore failures.
      if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
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

<div
  class="modal-backdrop"
  class:solid={!dismissible}
  role="presentation"
  onclick={handleBackdropClick}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="unlock-session-title"
    tabindex="-1"
  >
    <h3 id="unlock-session-title">Unlock encrypted data</h3>
    <p>
      Enter your passphrase to decrypt your data on this device. Your passphrase
      itself is never stored — once unlocked, this device stays unlocked until
      you log out.
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
      {#if error}
        <p class="field-error" role="alert">{error}</p>
      {/if}
      <div class="recovery-row">
        <button type="button" class="link" onclick={openRecovery} disabled={busy}>
          Use recovery code instead
        </button>
      </div>
      <div class="modal-actions">
        {#if dismissible}
          <button type="button" class="ghost" onclick={onClose} disabled={busy}>Cancel</button>
        {:else}
          <button type="button" class="ghost" onclick={logOut} disabled={busy}>Log out</button>
        {/if}
        <button type="submit" class="primary" disabled={!passphrase || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
    </form>
  </div>
</div>

{#if recoveryOpen}
  <RecoveryUnlockModal onClose={closeRecovery} onRecovered={handleRecovered} />
{/if}

{#if newRecoveryCode}
  <RecoveryCodesModal code={newRecoveryCode} onClose={acknowledgeNewCode} />
{/if}

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

  /* Lock-gate variant: fully opaque so the data behind it isn't visible
     while the session is locked. */
  .modal-backdrop.solid {
    background: var(--surface);
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

  .field-error {
    color: var(--accent-orange, #c5682f);
    font-size: 0.85rem;
    margin: 0.5rem 0 0;
  }

  .recovery-row {
    margin-top: 1rem;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .modal-actions button {
    font: inherit;
    font-weight: 600;
    padding: 0.45rem 1rem;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
  }

  .modal-actions .ghost,
  .modal-actions .primary {
    flex-shrink: 0;
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

  .recovery-row .link {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--brand);
    font-weight: 500;
    text-decoration: underline;
    cursor: pointer;
  }

  .recovery-row .link:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>

<script lang="ts">
  // Shown on the device that *owns* an E2EE migration (enable / disable / key
  // rotation) for as long as it is in flight. It is deliberately blocking and
  // non-dismissible: a migration is a multi-step server operation, and letting
  // the user keep editing or toggling things mid-flight is exactly what used to
  // leave migrations stuck. So we make them wait.
  //
  //  - While it is running we show progress and ask them to keep the tab open.
  //  - If it pauses (an error, or the session key was lost so we need the
  //    passphrase to continue) we surface the reason and collect the passphrase
  //    to resume right here — no bouncing out to a settings field that silently
  //    cleared on submit.
  import {
    resumeMigrationByDirection,
    resumeE2EEKeyRotation,
    resetEncryptionToPlain,
    startFreshToPlain,
  } from '$lib/sync/e2ee-migration';
  import { migrationResumePending } from '$lib/stores/syncStore';
  import { requestSync } from '$lib/sync/sync-orchestrator';
  import { db } from '$lib/db/schema';
  import BackupButton from '$lib/components/settings/BackupButton.svelte';

  type Direction = 'enable' | 'disable' | 'rotate';

  let {
    direction,
    converted,
    total,
    percent,
    error = null,
    awaitingPassphrase = false,
  }: {
    direction: Direction;
    converted?: number;
    total?: number;
    percent: number | null;
    error?: string | null;
    /** The orchestrator lost the cached key and needs the passphrase to go on. */
    awaitingPassphrase?: boolean;
  } = $props();

  // Anything other than "quietly running" means we put the passphrase + resume
  // affordance in front of the user: a hard error, or a known need for the key.
  const needsAction = $derived(awaitingPassphrase || !!error);

  const title = $derived(
    direction === 'disable'
      ? 'Turning off encryption'
      : direction === 'rotate'
        ? 'Rotating your encryption key'
        : 'Setting up encryption',
  );
  const runningLine = $derived(
    direction === 'disable'
      ? 'Switching your data back to plaintext sync.'
      : direction === 'rotate'
        ? 'Re-encrypting every record under your new key.'
        : 'Encrypting your data for end-to-end encryption.',
  );
  const passphraseHint = $derived(
    direction === 'rotate'
      ? 'Enter the passphrase you most recently set to continue.'
      : 'Enter your passphrase to continue.',
  );

  const hasTotal = $derived(typeof total === 'number' && total > 0);

  let passphrase = $state('');
  // Only used for a key rotation: a change-passphrase rotation needs the OLD
  // passphrase (to read rows still under the old key) and the NEW one (to read
  // the new key). For a panic rotate they're the same, so this stays blank.
  let newPassphrase = $state('');
  let busy = $state(false);
  let localError = $state<string | null>(null);
  let resetting = $state(false);

  // Whether this device holds any data worth keeping. Drives which recovery
  // options we offer: "keep my data" needs data; "start fresh" is for when there
  // is none (every device empty) and the encrypted copy can't be unlocked.
  let hasLocalData = $state(true);
  $effect(() => {
    void (async () => {
      const [w, i, p] = await Promise.all([
        db.weights.count(),
        db.injections.count(),
        db.prescriptions.count(),
      ]);
      hasLocalData = w + i + p > 0;
    })();
  });

  const shownError = $derived(localError ?? error);

  async function resume() {
    if (busy || !passphrase) return;
    busy = true;
    localError = null;
    try {
      // A rotation needs both keys; everything else needs one. For a panic
      // rotate the user leaves the new field blank, so it falls back to the
      // same passphrase for both bundles.
      const result =
        direction === 'rotate'
          ? await resumeE2EEKeyRotation(passphrase, newPassphrase || passphrase)
          : await resumeMigrationByDirection(direction, passphrase);
      if (result.completed) {
        migrationResumePending.set(null);
        passphrase = '';
        newPassphrase = '';
        requestSync();
      } else {
        // Keep the passphrase so a transient failure (e.g. a network blip) is
        // one click to retry, and show why it stopped instead of clearing.
        localError = result.error ?? 'Could not resume. Please try again.';
      }
    } catch (cause) {
      localError = (cause as Error).message ?? 'Could not resume. Please try again.';
    } finally {
      busy = false;
    }
  }

  // Escape hatch for a migration that can't be resumed because the server holds
  // encrypted rows under a key this device can't unlock (DEK mismatch from
  // cycling E2EE on/off). Re-establishes this device's data as plaintext and
  // discards the unreadable encrypted copy. Confirmed because it's destructive
  // to the server-side encrypted state.
  async function resetToPlain() {
    if (resetting || busy) return;
    const ok = confirm(
      "Reset encryption and keep THIS device's data?\n\n" +
        'Use this only if a migration is stuck and can’t be unlocked. It re-uploads ' +
        'the data on this device as plaintext and discards the encrypted copy on the ' +
        'server (which can no longer be opened). Your local data is NOT deleted, and you ' +
        'can turn encryption back on afterward.\n\n' +
        'Make sure your weigh-ins and doses are visible on this device before continuing.',
    );
    if (!ok) return;
    resetting = true;
    localError = null;
    try {
      await resetEncryptionToPlain();
      migrationResumePending.set(null);
      requestSync();
    } catch (cause) {
      localError = (cause as Error).message ?? 'Could not reset. Please try again.';
    } finally {
      resetting = false;
    }
  }

  // Last-resort escape when there's nothing to keep: erase the account's synced
  // data (the unrecoverable encrypted copy + any plaintext) and return to a
  // clean, usable plaintext state so the user can re-import from a backup. Very
  // destructive, so it's behind a type-to-confirm.
  async function startFresh() {
    if (resetting || busy) return;
    const typed = window.prompt(
      'Start over and ERASE the data synced to this account?\n\n' +
        'Use this only if you have no data on any device and the encrypted copy can’t be ' +
        'unlocked. It permanently deletes the synced data (which may be unrecoverable) and ' +
        'returns the app to a clean state so you can re-import from a backup file. Your account ' +
        'and license are kept.\n\n' +
        'Type "ERASE" to confirm.',
      '',
    );
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== 'ERASE') {
      localError = 'Confirmation text did not match — nothing was erased.';
      return;
    }
    resetting = true;
    localError = null;
    try {
      await startFreshToPlain();
      migrationResumePending.set(null);
      requestSync();
    } catch (cause) {
      localError = (cause as Error).message ?? 'Could not start fresh. Please try again.';
    } finally {
      resetting = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    // Enter submits when the resume form is up; Escape is intentionally inert
    // (the modal is non-dismissible).
    if (event.key === 'Enter' && needsAction) {
      event.preventDefault();
      void resume();
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="own-migration-title">
    <h3 id="own-migration-title">{title}</h3>

    {#if needsAction}
      <p>{runningLine} It paused and needs you to finish it.</p>
    {:else}
      <p>{runningLine} Please keep this tab open until it finishes.</p>
    {/if}

    <div class="progress" aria-live="polite">
      <div
        class="bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent ?? undefined}
      >
        <div
          class="fill"
          class:indeterminate={percent == null}
          class:paused={needsAction}
          style={percent == null ? '' : `width: ${percent}%`}
        ></div>
      </div>
      <p class="progress-label">
        {#if hasTotal}
          {converted ?? 0} of {total} records{percent != null ? ` · ${percent}%` : ''}
        {:else if needsAction}
          Paused
        {:else}
          Working…
        {/if}
      </p>
    </div>

    {#if needsAction}
      {#if shownError}
        <p class="field-error" role="alert">{shownError}</p>
      {/if}

      {#if direction === 'rotate'}
        <label class="passphrase">
          Passphrase you were using before
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="password"
            bind:value={passphrase}
            placeholder="Previous passphrase"
            autocomplete="off"
            autofocus
            disabled={busy}
            onkeydown={onKeydown}
          />
        </label>
        <label class="passphrase">
          New passphrase <span class="optional">(leave blank if you didn’t change it)</span>
          <input
            type="password"
            bind:value={newPassphrase}
            placeholder="New passphrase"
            autocomplete="off"
            disabled={busy}
            onkeydown={onKeydown}
          />
        </label>
      {:else}
        <label class="passphrase">
          {passphraseHint}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="password"
            bind:value={passphrase}
            placeholder="Passphrase"
            autocomplete="current-password"
            autofocus
            disabled={busy}
            onkeydown={onKeydown}
          />
        </label>
      {/if}

      <div class="modal-actions">
        <button type="button" class="primary" onclick={resume} disabled={busy || resetting || !passphrase}>
          {busy ? 'Resuming…' : 'Resume'}
        </button>
      </div>

      <div class="backup-slot">
        <BackupButton compact />
      </div>

      <div class="reset-block">
        {#if hasLocalData}
          <p class="reset-note">
            Stuck and can’t unlock? You can reset encryption and keep the data on
            this device, then turn it back on cleanly.
          </p>
          <button type="button" class="reset-btn" onclick={resetToPlain} disabled={resetting || busy}>
            {resetting ? 'Resetting…' : 'Reset encryption & keep this device’s data'}
          </button>
          <button type="button" class="reset-btn danger" onclick={startFresh} disabled={resetting || busy}>
            Start fresh &amp; erase synced data
          </button>
        {:else}
          <p class="reset-note">
            There’s no data on this device. If all your devices are empty and this
            can’t be unlocked, start fresh to get back into your account, then
            re-import from a backup file.
          </p>
          <button type="button" class="reset-btn danger" onclick={startFresh} disabled={resetting || busy}>
            {resetting ? 'Erasing…' : 'Start fresh & erase synced data'}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<svelte:window onkeydown={onKeydown} />

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

  .progress {
    margin: 0 0 1rem;
  }

  .bar {
    height: 0.55rem;
    border-radius: 999px;
    background: color-mix(in oklab, var(--text) 12%, var(--surface));
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: 999px;
    background: var(--brand);
    transition: width var(--motion-fast, 160ms) ease-out;
  }

  .fill.paused {
    background: var(--warning, #e08a3c);
  }

  /* No total yet: a quiet sweeping bar so the user sees it's alive. */
  .fill.indeterminate {
    width: 35%;
    animation: slide 1.2s ease-in-out infinite;
  }

  @keyframes slide {
    0% { margin-left: -35%; }
    100% { margin-left: 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .fill.indeterminate { animation: none; width: 100%; opacity: 0.4; }
  }

  .progress-label {
    margin: 0.4rem 0 0;
    font-size: 0.85rem;
    color: color-mix(in oklab, var(--text) 70%, transparent);
  }

  .field-error {
    color: var(--accent-orange, #c5682f);
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }

  .passphrase {
    display: block;
    font-size: 0.9rem;
    font-weight: 500;
    margin: 0 0 0.9rem;
  }

  .optional {
    font-weight: 400;
    color: color-mix(in oklab, var(--text) 55%, transparent);
  }

  .passphrase input {
    margin-top: 0.35rem;
    width: 100%;
    padding: 0.6rem 0.7rem;
    border: 1px solid color-mix(in oklab, var(--text) 25%, transparent);
    border-radius: 8px;
    font: inherit;
    background: var(--surface);
    color: var(--text);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .modal-actions button {
    font: inherit;
    font-weight: 600;
    padding: 0.45rem 1.1rem;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
  }

  .modal-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .modal-actions .primary {
    background: var(--brand);
    border: 1px solid var(--brand);
    color: #fff;
  }

  .backup-slot {
    margin-top: 0.9rem;
    display: flex;
    justify-content: center;
  }

  .reset-block {
    margin-top: 1rem;
    padding-top: 0.85rem;
    border-top: 1px solid color-mix(in oklab, var(--text) 12%, transparent);
  }
  .reset-note {
    margin: 0 0 0.5rem;
    font-size: 0.8rem;
    color: color-mix(in oklab, var(--text) 60%, transparent);
  }
  .reset-btn {
    display: block;
    width: 100%;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.45rem 0.9rem;
    border-radius: 999px;
    background: var(--surface);
    color: color-mix(in oklab, var(--danger, #b91c1c) 80%, var(--text) 20%);
    border: 1px solid color-mix(in oklab, var(--danger, #b91c1c) 45%, transparent);
    cursor: pointer;
  }
  .reset-btn + .reset-btn {
    margin-top: 0.5rem;
  }
  .reset-btn:hover:not(:disabled) {
    background: color-mix(in oklab, var(--danger, #b91c1c) 8%, var(--surface));
  }
  /* The irreversible "erase synced data" action — solid fill so it reads as the
   * heavier choice, not a sibling of the keep-my-data reset. */
  .reset-btn.danger {
    background: color-mix(in oklab, var(--danger, #b91c1c) 88%, white 12%);
    color: #fff;
    border-color: color-mix(in oklab, var(--danger, #b91c1c) 70%, black 30%);
  }
  .reset-btn.danger:hover:not(:disabled) {
    background: color-mix(in oklab, var(--danger, #b91c1c) 95%, black 5%);
  }
  .reset-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>

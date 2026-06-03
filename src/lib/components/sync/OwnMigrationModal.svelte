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
  import { resumeMigrationByDirection } from '$lib/sync/e2ee-migration';
  import { migrationResumePending } from '$lib/stores/syncStore';
  import { requestSync } from '$lib/sync/sync-orchestrator';
  import { downloadBackup } from '$lib/importExport/backup';

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
  let busy = $state(false);
  let localError = $state<string | null>(null);
  let backupBusy = $state(false);

  const shownError = $derived(localError ?? error);

  async function resume() {
    if (busy || !passphrase) return;
    busy = true;
    localError = null;
    try {
      const result = await resumeMigrationByDirection(direction, passphrase);
      if (result.completed) {
        migrationResumePending.set(null);
        passphrase = '';
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

  async function backup() {
    if (backupBusy) return;
    backupBusy = true;
    try {
      await downloadBackup();
    } catch (cause) {
      localError = `Backup failed: ${(cause as Error).message}`;
    } finally {
      backupBusy = false;
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

      <div class="modal-actions">
        <button type="button" class="primary" onclick={resume} disabled={busy || !passphrase}>
          {busy ? 'Resuming…' : 'Resume'}
        </button>
      </div>

      <button type="button" class="link" onclick={backup} disabled={backupBusy}>
        {backupBusy ? 'Preparing backup…' : 'Download a backup first'}
      </button>
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

  .link {
    display: block;
    margin: 0.85rem auto 0;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.85rem;
    color: color-mix(in oklab, var(--text) 65%, transparent);
    text-decoration: underline;
    text-underline-offset: 0.18rem;
    cursor: pointer;
  }

  .link:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>

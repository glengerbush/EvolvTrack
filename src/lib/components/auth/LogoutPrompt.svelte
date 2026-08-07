<script lang="ts">
  import type { PendingOutgoingChanges } from '$lib/sync/pending-outgoing-changes';

  let {
    pending,
    error = null,
    busy = false,
    onSync,
    onDiscard,
    onCancel,
  }: {
    pending: PendingOutgoingChanges;
    error?: string | null;
    busy?: boolean;
    onSync: () => void | Promise<void>;
    onDiscard: () => void | Promise<void>;
    onCancel: () => void;
  } = $props();

  const groups = $derived([
    pending.healthEntries
      ? `${pending.healthEntries} Health ${pending.healthEntries === 1 ? 'Entry' : 'Entries'}`
      : null,
    pending.vials ? `${pending.vials} ${pending.vials === 1 ? 'Vial' : 'Vials'}` : null,
    pending.settings
      ? `${pending.settings} settings ${pending.settings === 1 ? 'change' : 'changes'}`
      : null,
  ].filter((group): group is string => group !== null));

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) onCancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={(event) => {
    if (!busy && event.target === event.currentTarget) onCancel();
  }}
>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="logout-pending-title">
    <h2 id="logout-pending-title">
      {pending.total} {pending.total === 1 ? 'change hasn’t' : 'changes haven’t'} synced
    </h2>
    <p>{groups.join(', ')} {pending.total === 1 ? 'exists' : 'exist'} only in this copy of EvolvTrack.</p>
    <p>Logging out without syncing permanently removes {pending.total === 1 ? 'this change' : 'these changes'}.</p>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button class="primary" type="button" disabled={busy} onclick={() => void onSync()}>
        {busy ? 'Syncing…' : error ? 'Try sync again' : 'Sync and log out'}
      </button>
      <button class="danger" type="button" disabled={busy} onclick={() => void onDiscard()}>
        Log out and lose changes
      </button>
      <button type="button" disabled={busy} onclick={onCancel}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(0 0 0 / 0.55);
  }

  .dialog {
    width: min(32rem, 100%);
    padding: 1.4rem;
    border: 1px solid var(--border);
    border-radius: 1rem;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 1rem 3rem rgb(0 0 0 / 0.28);
  }

  h2 { margin: 0 0 0.8rem; }
  p { line-height: 1.5; }
  .error { color: var(--danger, #b42318); }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-top: 1.2rem;
  }

  button {
    min-height: 2.65rem;
    padding: 0.55rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    background: var(--surface-2, var(--surface));
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  button:disabled { cursor: wait; opacity: 0.65; }
  .primary { border-color: var(--accent); background: var(--accent); color: white; }
  .danger { border-color: var(--danger, #b42318); color: var(--danger, #b42318); }
</style>

<script lang="ts">
  // Shown on a device that finds an E2EE migration running on *another* device.
  // It reassures (the migration finishes on its own and this device's data is
  // safe meanwhile) and shows live progress. The modal is non-dismissible —
  // waiting is implicit (it closes itself when the other device finishes), and
  // the only action is to take the migration over here, emphasised once the
  // other device's heartbeat looks stale.
  import { focusTrap } from '$lib/utils/focusTrap';

  type Direction = 'enable' | 'disable' | 'rotate';

  let {
    direction,
    converted,
    total,
    percent,
    stale,
    takingOver = false,
    error = null,
    onTakeOver,
  }: {
    direction: Direction;
    converted?: number;
    total?: number;
    percent: number | null;
    stale: boolean;
    takingOver?: boolean;
    error?: string | null;
    onTakeOver: () => void;
  } = $props();

  const verb = $derived(
    direction === 'disable'
      ? 'switching your data back to plaintext'
      : direction === 'rotate'
        ? 'rotating your encryption key'
        : 'encrypting your data',
  );
  const title = $derived(
    direction === 'disable'
      ? 'Disabling encryption on another device'
      : direction === 'rotate'
        ? 'Rotating your key on another device'
        : 'Encryption setup in progress',
  );
  const hasTotal = $derived(typeof total === 'number' && total > 0);

  // Non-dismissible: Escape and backdrop clicks are inert. The modal clears
  // itself when the other device's migration completes (SyncGate polls).
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') event.preventDefault();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-backdrop" role="presentation">
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="migration-progress-title"
    tabindex="-1"
    use:focusTrap
  >
    <h3 id="migration-progress-title">{title}</h3>
    <p>
      Another device you are logged into is {verb}. Once complete, you can use the app normally again.
    </p>

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
          style={percent == null ? '' : `width: ${percent}%`}
        ></div>
      </div>
      <p class="progress-label">
        {#if hasTotal}
          {converted ?? 0} of {total} records{percent != null ? ` · ${percent}%` : ''}
        {:else}
          Starting…
        {/if}
      </p>
    </div>

    {#if stale}
      <p class="stale" role="alert">
        No progress for a while — that device may be offline. If you think it
        stalled, you can take over and finish here.
      </p>
    {/if}
    {#if error}
      <p class="field-error" role="alert">{error}</p>
    {/if}

    {#if !stale && !takingOver}
      <p class="takeover-hint">
        There's nothing to do meanwhile — this finishes on its own. Take-over
        unlocks only if that device stops responding.
      </p>
    {/if}

    <div class="modal-actions">
      <button
        type="button"
        class={stale ? 'primary' : 'ghost'}
        onclick={onTakeOver}
        disabled={takingOver || !stale}
        title={stale ? undefined : 'Available if the other device stops responding'}
      >
        {takingOver ? 'Taking over…' : 'Take over on this device'}
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

  .stale {
    margin: 0 0 0.75rem;
    font-size: 0.88rem;
    font-weight: 500;
    color: color-mix(in oklab, var(--warning, #e08a3c) 75%, var(--text) 25%);
  }

  .field-error {
    color: var(--accent-orange, #c5682f);
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }

  .takeover-hint {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    color: color-mix(in oklab, var(--text) 65%, transparent);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .modal-actions button {
    font: inherit;
    font-weight: 600;
    padding: 0.45rem 1rem;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
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

<script lang="ts">
  import {
    deviceDataErasureState,
    retryDeviceDataErasure,
  } from '$lib/security/device-data-erasure';

  let retrying = $state(false);

  async function retry() {
    if (retrying) return;
    retrying = true;
    try {
      await retryDeviceDataErasure();
      window.location.reload();
    } catch {
      // The module publishes the retryable failure through its state.
    } finally {
      retrying = false;
    }
  }
</script>

{#if $deviceDataErasureState.status === 'erasing' || $deviceDataErasureState.status === 'blocked'}
  <div class="backdrop">
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="erasure-title">
      <h2 id="erasure-title">Finishing removal from this app</h2>
      <p>EvolvTrack must finish removing stored data before it can be used again.</p>
      {#if $deviceDataErasureState.status === 'blocked'}
        <p>Close other EvolvTrack tabs, then retry.</p>
        <p class="error">{$deviceDataErasureState.message}</p>
        <button type="button" disabled={retrying} onclick={() => void retry()}>
          {retrying ? 'Retrying…' : 'Retry removal'}
        </button>
      {:else}
        <p>Removing health data, encryption keys, credentials, and preferences…</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(0 0 0 / 0.65);
  }

  .dialog {
    width: min(32rem, 100%);
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 1rem;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 1rem 3rem rgb(0 0 0 / 0.3);
  }

  h2 { margin-top: 0; }
  p { line-height: 1.5; }
  .error { color: var(--danger, #b42318); }
  button {
    min-height: 2.65rem;
    padding: 0.55rem 0.9rem;
    border: 1px solid var(--accent);
    border-radius: 0.65rem;
    background: var(--accent);
    color: white;
    font: inherit;
    cursor: pointer;
  }
</style>

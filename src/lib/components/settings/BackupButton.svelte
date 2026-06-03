<script lang="ts">
  // Optional "download a backup" affordance, shown before any E2EE change
  // (enable, disable, rotate key, change passphrase, or a migration). Never
  // required — just an obvious, warning-tinted safety net so a user can grab a
  // copy of their data before touching encryption, where mistakes are costly.
  import { downloadBackup } from '$lib/importExport/backup';

  let { compact = false }: { compact?: boolean } = $props();

  let busy = $state(false);
  let done = $state(false);
  let error = $state<string | null>(null);

  async function run() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await downloadBackup();
      done = true;
    } catch (cause) {
      error = (cause as Error).message ?? 'Backup failed.';
    } finally {
      busy = false;
    }
  }
</script>

<div class="backup" class:compact>
  <button type="button" class="backup-btn" onclick={run} disabled={busy}>
    <span aria-hidden="true">⬇</span>
    {busy ? 'Preparing backup…' : done ? 'Backup downloaded ✓' : 'Download a backup'}
  </button>
  {#if !compact}
    <span class="backup-hint">
      Optional, but recommended before changing encryption — keeps a copy of your
      data on this device just in case.
    </span>
  {/if}
  {#if error}<span class="backup-error" role="alert">{error}</span>{/if}
</div>

<style>
  .backup {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    align-items: flex-start;
  }

  .backup-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font: inherit;
    font-weight: 700;
    font-size: 0.9rem;
    padding: 0.5rem 0.95rem;
    border-radius: 999px;
    cursor: pointer;
    /* Warning-tinted so it reads as a precaution, not a primary action. */
    background: color-mix(in oklab, var(--warning, #e08a3c) 18%, var(--surface, #fff));
    color: color-mix(in oklab, var(--warning, #e08a3c) 72%, var(--text, #000) 28%);
    border: 1.5px solid color-mix(in oklab, var(--warning, #e08a3c) 55%, transparent);
  }
  .backup-btn:hover:not(:disabled) {
    background: color-mix(in oklab, var(--warning, #e08a3c) 28%, var(--surface, #fff));
  }
  .backup-btn:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .backup-hint {
    font-size: 0.8rem;
    color: color-mix(in oklab, var(--text, #000) 60%, transparent);
    line-height: 1.3;
  }

  .backup-error {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--danger, #b91c1c);
  }
</style>

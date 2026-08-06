<script lang="ts">
  let {
    code,
    onDone,
    onContinueWithout,
  }: {
    code: string;
    onDone: () => Promise<void> | void;
    onContinueWithout: () => Promise<void> | void;
  } = $props();

  let copyLabel = $state('Copy');
  let busy = $state(false);
  let error = $state('');

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      copyLabel = 'Copied!';
      setTimeout(() => (copyLabel = 'Copy'), 1800);
    } catch {
      copyLabel = 'Copy failed';
      setTimeout(() => (copyLabel = 'Copy'), 1800);
    }
  }

  async function choose(action: () => Promise<void> | void) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch (cause) {
      error = (cause as Error).message;
      busy = false;
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="recovery-code-title"
    tabindex="-1"
  >
    <h3 id="recovery-code-title">Recovery code</h3>
    <p>
      Save this code somewhere safe — a password manager, a printed copy. It
      won't be shown again. If you lose both your passphrase and this code,
      your encrypted data cannot be recovered.
    </p>
    <p class="code-box"><code>{code}</code></p>
    {#if error}<p class="modal-error" role="alert">{error}</p>{/if}
    <div class="modal-actions">
      <button type="button" class="ghost" disabled={busy} onclick={() => choose(onContinueWithout)}>
        Continue without recovery code
      </button>
      <button type="button" class="ghost" disabled={busy} onclick={copyCode}>{copyLabel}</button>
      <button type="button" class="primary" disabled={busy} onclick={() => choose(onDone)}>
        {busy ? 'Saving…' : 'Done'}
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
    background: var(--surface, #fff);
    color: var(--text, #111);
    border: 1px solid color-mix(in oklab, var(--text, #111) 18%, transparent);
    border-radius: var(--radius-md, 12px);
    padding: 1.25rem;
    max-width: 30rem;
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

  .code-box {
    padding: 0.65rem 0.8rem;
    background: color-mix(in oklab, var(--text, #111) 6%, transparent);
    border-radius: 8px;
    text-align: center;
    word-break: break-all;
    color: var(--text, #111);
  }

  .code-box code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 1rem;
    letter-spacing: 0.06em;
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

  .modal-error {
    color: var(--danger, #b42318) !important;
  }
</style>

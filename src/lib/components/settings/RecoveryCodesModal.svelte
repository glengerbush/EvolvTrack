<script lang="ts">
  let {
    codes,
    onClose,
  }: {
    codes: string[];
    onClose: () => void;
  } = $props();

  let copyLabel = $state('Copy all');

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      copyLabel = 'Copied!';
      setTimeout(() => (copyLabel = 'Copy all'), 1800);
    } catch {
      copyLabel = 'Copy failed';
      setTimeout(() => (copyLabel = 'Copy all'), 1800);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-backdrop" role="presentation" onclick={handleBackdropClick}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="recovery-codes-title"
    tabindex="-1"
  >
    <h3 id="recovery-codes-title">Recovery codes</h3>
    <p>
      Save these somewhere safe — a password manager, a printed copy. They
      won't be shown again once you close this dialog. Generate a fresh set
      anytime from your encryption settings.
    </p>
    <ul class="codes-list">
      {#each codes as code (code)}
        <li><code>{code}</code></li>
      {/each}
    </ul>
    <div class="modal-actions">
      <button type="button" class="ghost" onclick={onClose}>Done</button>
      <button type="button" class="primary" onclick={copyCodes}>{copyLabel}</button>
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

  .codes-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .codes-list li {
    background: color-mix(in oklab, var(--text, #111) 5%, transparent);
    border-radius: 6px;
    padding: 0.45rem 0.6rem;
    text-align: center;
  }

  .codes-list code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
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
</style>

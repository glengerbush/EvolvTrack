<script lang="ts">
  import { onMount } from 'svelte';
  import {
    claimLicense,
    fetchLicenseStatus,
    regenerateCode,
    releaseLicense,
    verifyCurrentPassword,
    type LicenseStatusRow,
  } from '$lib/sync/license';

  let loading = $state(true);
  let license = $state<LicenseStatusRow | null>(null);

  let claimCodeInput = $state('');
  let busy = $state(false);
  let status = $state('');
  let statusKind = $state<'info' | 'success' | 'error'>('info');

  // password reconfirm + reveal flow
  type Mode = 'idle' | 'regenerate' | 'transfer';
  let mode = $state<Mode>('idle');
  let password = $state('');
  let revealedCode = $state<string | null>(null);

  const tierLabel = $derived(license ? formatTier(license.tier) : '');
  const expiryLabel = $derived(license ? formatExpiry(license) : '');
  const isActive = $derived(!!license && license.is_active);

  onMount(() => { void refresh(); });

  async function refresh() {
    loading = true;
    try {
      license = await fetchLicenseStatus();
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      loading = false;
    }
  }

  function setStatus(kind: 'info' | 'success' | 'error', message: string) {
    statusKind = kind;
    status = message;
  }

  function resetReconfirm() {
    mode = 'idle';
    password = '';
    revealedCode = null;
  }

  async function handleClaim() {
    if (!claimCodeInput.trim()) { setStatus('error', 'Enter a license code.'); return; }
    busy = true;
    setStatus('info', 'Claiming license…');
    try {
      await claimLicense(claimCodeInput);
      claimCodeInput = '';
      await refresh();
      setStatus('success', 'License claimed. Cloud sync is now available.');
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  function startRegenerate()  { mode = 'regenerate'; password = ''; revealedCode = null; setStatus('info', ''); }
  function startTransfer()    { mode = 'transfer';   password = ''; revealedCode = null; setStatus('info', ''); }

  async function confirmRegenerate() {
    busy = true;
    try {
      await verifyCurrentPassword(password);
      const newCode = await regenerateCode();
      revealedCode = newCode;
      password = '';
      await refresh();
      setStatus('success', 'New code generated. The old code is now invalid.');
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  async function confirmTransfer() {
    if (!confirm('Release this license? You will lose cloud sync immediately. The recipient can then claim the code on their account.')) return;
    busy = true;
    try {
      await verifyCurrentPassword(password);
      // Surface the current code one more time would be ideal, but we never
      // stored it. The user must have copied it (or regenerated) beforehand.
      await releaseLicense();
      await refresh();
      resetReconfirm();
      setStatus('success', 'License released. Sync is now disabled on this account.');
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('success', 'Code copied to clipboard.');
    } catch {
      setStatus('error', 'Could not copy to clipboard. Select and copy manually.');
    }
  }

  function formatTier(tier: string) {
    return tier.charAt(0).toUpperCase() + tier.slice(1);
  }

  function formatExpiry(row: LicenseStatusRow) {
    if (!row.period_end) return 'No expiry';
    const d = new Date(row.period_end);
    if (Number.isNaN(d.getTime())) return row.period_end;
    return d.toLocaleDateString([], { dateStyle: 'medium' });
  }
</script>

<div class="card-wrap">
  <h2>Cloud Sync License</h2>
  <div class="panel">
    {#if loading}
      <p class="toggle-hint">Loading license status…</p>
    {:else if !license}
      <p class="toggle-hint">
        Cloud sync requires a license code. If you have one, paste it below.
        Otherwise EvolvTrack continues to work locally without sync.
      </p>
      <label>
        License code
        <input
          bind:value={claimCodeInput}
          type="text"
          placeholder="EVOLV-XXXXX-XXXXX-XXXXX"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <button
        class="btn btn-primary"
        disabled={busy || !claimCodeInput.trim()}
        onclick={handleClaim}
      >{busy ? 'Claiming…' : 'Claim license'}</button>
    {:else}
      <div class="status-row">
        <span class="license-pill" data-active={isActive ? 'true' : 'false'}>
          {isActive ? 'Active' : license.status === 'revoked' ? 'Revoked' : 'Expired'}
        </span>
        <span class="license-tier">{tierLabel}</span>
        <span class="license-meta">Expires: {expiryLabel}</span>
      </div>
      <p class="toggle-hint">Code prefix: <code>{license.code_prefix}</code>…</p>

      {#if mode === 'idle'}
        <p class="toggle-hint">
          EvolvTrack stores only a hash of your code — it can never be shown
          back to you. If you need a copy (to back up or to transfer), generate
          a fresh one and save it.
        </p>
        <div class="action-row">
          <button class="btn btn-ghost" disabled={busy} onclick={startRegenerate}>Regenerate code</button>
          <button class="btn btn-ghost" disabled={busy} onclick={startTransfer}>Transfer (release)</button>
        </div>

        <details class="help-block">
          <summary>How transfer works</summary>
          <div class="help-body">
            <p>
              To give your license to someone else: <strong>Regenerate</strong>
              first, save the new code somewhere safe, then click
              <strong>Transfer (release)</strong>. The recipient pastes the
              code on their own settings page to claim it.
            </p>
            <p>
              The original buyer still controls billing for monthly/yearly
              subscriptions — only the entitlement moves with the code.
            </p>
          </div>
        </details>
      {:else if mode === 'regenerate'}
        {#if revealedCode}
          <div class="revealed">
            <p class="warn">
              <strong>Save this code now — it will not be shown again.</strong>
              The old code has been invalidated.
            </p>
            <code class="code-display">{revealedCode}</code>
            <div class="action-row">
              <button class="btn btn-primary" onclick={() => copyToClipboard(revealedCode!)}>Copy code</button>
              <button class="btn btn-ghost" onclick={resetReconfirm}>I've saved it</button>
            </div>
          </div>
        {:else}
          <p class="warn">
            Regenerating will <strong>immediately invalidate</strong> the old code.
            Anyone holding the old code (including you) will not be able to use it.
            The new code will be shown <strong>only once</strong>.
          </p>
          <label>
            Confirm your password
            <input bind:value={password} type="password" autocomplete="current-password" />
          </label>
          <div class="action-row">
            <button class="btn btn-ghost" disabled={busy} onclick={resetReconfirm}>Cancel</button>
            <button class="btn btn-primary" disabled={busy || !password} onclick={confirmRegenerate}>
              {busy ? 'Generating…' : 'Generate new code'}
            </button>
          </div>
        {/if}
      {:else if mode === 'transfer'}
        <p class="warn">
          Releasing returns the license to <em>unclaimed</em>. Make sure you
          have a copy of the code first — once released, anyone with the code
          can claim it. <strong>Tip:</strong> regenerate before transferring so
          you know the code in circulation is fresh.
        </p>
        <label>
          Confirm your password
          <input bind:value={password} type="password" autocomplete="current-password" />
        </label>
        <div class="action-row">
          <button class="btn btn-ghost" disabled={busy} onclick={resetReconfirm}>Cancel</button>
          <button class="btn btn-primary" disabled={busy || !password} onclick={confirmTransfer}>
            {busy ? 'Releasing…' : 'Release license'}
          </button>
        </div>
      {/if}
    {/if}

    {#if status}
      <p class="status-msg" data-kind={statusKind}>{status}</p>
    {/if}
  </div>
</div>

<style>
  .card-wrap {
    display: grid;
    align-items: end;
    grid-template-rows: auto 1fr;
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 700;
    font-variant: small-caps;
    color: var(--headerText);
    background: color-mix(in oklab, var(--headerBg) 92%, white 8%);
    border: 1px solid var(--cardBorder);
    border-bottom: none;
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
    padding: 0.45rem 0.85rem 0.5rem;
    width: fit-content;
    line-height: 1;
  }

  .panel {
    display: grid;
    gap: 0.65rem;
    border: 1px solid var(--cardBorder);
    border-radius: 0 14px 14px 14px;
    padding: 0.8rem;
    background: color-mix(in oklab, var(--surface) 86%, transparent);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.16);
  }

  input {
    padding: 0.7rem;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 60%, white 40%);
    border-radius: 10px;
    display: block;
    width: min(100%, 380px);
    font: inherit;
  }

  input:focus {
    outline: none;
    border-color: var(--cardBorder);
  }

  .status-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .license-pill {
    display: inline-flex;
    align-items: center;
    min-height: 1.9rem;
    border: 1px solid var(--cardBorder);
    border-radius: 999px;
    padding: 0.18rem 0.72rem;
    font-size: 0.85rem;
    font-weight: 800;
    background: color-mix(in oklab, var(--headerBg) 14%, white 86%);
    color: #253024;
  }

  .license-pill[data-active='true'] {
    background: color-mix(in oklab, var(--success) 18%, white 82%);
    border-color: var(--success);
  }

  .license-pill:not([data-active='true']) {
    background: color-mix(in oklab, var(--danger) 16%, white 84%);
    border-color: var(--danger);
  }

  .license-tier {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .license-meta {
    color: #555;
    font-size: 0.88rem;
  }

  .action-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.5rem;
  }

  .toggle-hint {
    margin: 0;
    font-size: 0.88rem;
    color: #666;
  }

  .toggle-hint code {
    background: #f0f0f0;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    font-size: 0.85em;
  }

  .warn {
    margin: 0;
    padding: 0.6rem 0.75rem;
    background: color-mix(in oklab, var(--warning) 18%, white 82%);
    border: 1px solid var(--warning);
    border-radius: 10px;
    font-size: 0.9rem;
    line-height: 1.4;
    color: #3a2000;
  }

  .revealed {
    display: grid;
    gap: 0.55rem;
  }

  .code-display {
    display: block;
    padding: 0.75rem 1rem;
    background: #111;
    color: #f1f1f1;
    border-radius: 10px;
    font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 1.1rem;
    letter-spacing: 0.04em;
    user-select: all;
    word-break: break-all;
  }

  .help-block {
    margin-top: 0.25rem;
    font-size: 0.88rem;
    color: #666;
  }

  .help-block > summary {
    cursor: pointer;
    width: fit-content;
    font-weight: 600;
    color: var(--cardBorder);
  }

  .help-block > summary:hover {
    text-decoration: underline;
  }

  .help-body {
    margin-top: 0.5rem;
    display: grid;
    gap: 0.45rem;
    line-height: 1.45;
  }

  .help-body p {
    margin: 0;
  }

  .status-msg {
    margin: 0.25rem 0 0;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .status-msg[data-kind='success'] { color: var(--success); }
  .status-msg[data-kind='error']   { color: var(--danger); }
  .status-msg[data-kind='info']    { color: #475569; }

  .panel :global(button) {
    opacity: 0.8;
    border-radius: 11px;
  }

  .panel :global(.btn-primary) {
    background: var(--headerBg);
    color: var(--headerText);
    border: 1px solid var(--cardBorder);
    opacity: 1;
  }

  .panel :global(.btn-ghost) {
    background: color-mix(in oklab, var(--headerBg) 14%, var(--surface) 86%);
    color: var(--text);
    border: 1px solid color-mix(in oklab, var(--cardBorder) 65%, var(--surface) 35%);
    opacity: 1;
  }

  .panel :global(.btn:disabled) {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>

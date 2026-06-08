<script lang="ts">
  import { onMount } from 'svelte';
  import {
    adminChangeTier,
    adminGenerateLicenses,
    adminGrantAdminByIdentifier,
    adminListAdmins,
    adminListLicenses,
    adminRevoke,
    adminRevokeAdmin,
    adminSetNote,
    amIAdmin,
    type AdminGeneratedCode,
    type AdminInfo,
    type AdminLicenseRow,
    type LicenseTier,
  } from '$lib/sync/license';

  let checking = $state(true);
  let isAdmin = $state(false);
  let initError = $state('');

  let licenses = $state<AdminLicenseRow[]>([]);
  let admins = $state<AdminInfo[]>([]);
  let filter = $state('');
  let busy = $state(false);
  let status = $state('');
  let statusKind = $state<'info' | 'success' | 'error'>('info');

  // generation form
  let genTier = $state<LicenseTier>('lifetime');
  let genCount = $state(1);
  let genNote = $state('');
  let genPeriodEnd = $state('');
  let generated = $state<AdminGeneratedCode[]>([]);

  // per-row edit state
  let editingId = $state<string | null>(null);
  let editTier = $state<LicenseTier>('monthly');
  let editPeriodEnd = $state('');
  let editNote = $state('');

  // admin management
  let newAdminIdentifier = $state('');

  onMount(() => { void boot(); });

  async function boot() {
    checking = true;
    try {
      isAdmin = await amIAdmin();
      if (isAdmin) {
        await Promise.all([refreshLicenses(), refreshAdmins()]);
      }
    } catch (error) {
      initError = (error as Error).message;
    } finally {
      checking = false;
    }
  }

  function setStatus(kind: 'info' | 'success' | 'error', message: string) {
    statusKind = kind;
    status = message;
  }

  async function refreshLicenses() {
    licenses = await adminListLicenses(filter.trim() || null, 200, 0);
  }

  async function refreshAdmins() {
    admins = await adminListAdmins();
  }

  async function handleSearch() {
    busy = true;
    try {
      await refreshLicenses();
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  async function handleGenerate() {
    if (genCount < 1 || genCount > 500) {
      setStatus('error', 'Count must be between 1 and 500.');
      return;
    }
    busy = true;
    setStatus('info', 'Generating…');
    try {
      const result = await adminGenerateLicenses(
        genTier,
        genCount,
        genNote.trim() || null,
        genPeriodEnd ? new Date(genPeriodEnd).toISOString() : null,
      );
      generated = result;
      await refreshLicenses();
      setStatus('success', `Generated ${result.length} code${result.length === 1 ? '' : 's'}. Save them now — they cannot be shown again.`);
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  function startEdit(row: AdminLicenseRow) {
    editingId = row.license_id;
    editTier = row.tier;
    editPeriodEnd = row.period_end ? row.period_end.slice(0, 10) : '';
    editNote = row.note ?? '';
  }

  function cancelEdit() {
    editingId = null;
  }

  async function saveEdit(row: AdminLicenseRow) {
    busy = true;
    try {
      const newEndIso = editPeriodEnd ? new Date(editPeriodEnd).toISOString() : null;
      if (editTier !== row.tier || newEndIso !== row.period_end) {
        await adminChangeTier(row.license_id, editTier, newEndIso);
      }
      if ((editNote || '') !== (row.note || '')) {
        await adminSetNote(row.license_id, editNote);
      }
      await refreshLicenses();
      editingId = null;
      setStatus('success', 'License updated.');
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  async function handleRevoke(row: AdminLicenseRow) {
    const reason = window.prompt(`Revoke license ${row.code_prefix}…? Enter a reason (optional):`, '');
    if (reason === null) return;
    busy = true;
    try {
      await adminRevoke(row.license_id, reason || null);
      await refreshLicenses();
      setStatus('success', 'License revoked.');
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  async function handleGrantAdmin() {
    if (!newAdminIdentifier.trim()) return;
    busy = true;
    try {
      await adminGrantAdminByIdentifier(newAdminIdentifier.trim());
      newAdminIdentifier = '';
      await refreshAdmins();
      setStatus('success', 'Admin added.');
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  async function handleRevokeAdmin(uid: string) {
    if (!confirm('Remove this admin?')) return;
    busy = true;
    try {
      await adminRevokeAdmin(uid);
      await refreshAdmins();
      setStatus('success', 'Admin removed.');
    } catch (error) {
      setStatus('error', (error as Error).message);
    } finally {
      busy = false;
    }
  }

  async function copyAllCodes() {
    if (!generated.length) return;
    const text = generated.map((g) => g.code).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus('success', 'Codes copied to clipboard.');
    } catch {
      setStatus('error', 'Could not copy. Select and copy manually.');
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { dateStyle: 'medium' });
  }
</script>

<section class="admin">
  <h1>License Admin</h1>

  {#if checking}
    <p>Checking access…</p>
  {:else if initError}
    <p class="error">{initError}</p>
  {:else if !isAdmin}
    <p class="error">You are not an admin.</p>
  {:else}
    <div class="card">
      <h2>Generate codes</h2>
      <div class="form-row">
        <label>Tier
          <select bind:value={genTier}>
            <option value="lifetime">Lifetime</option>
            <option value="yearly">Yearly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label>Count
          <input type="number" min="1" max="500" bind:value={genCount} />
        </label>
        <label>Expires (optional)
          <input type="date" bind:value={genPeriodEnd} />
        </label>
        <label class="grow">Note
          <input type="text" bind:value={genNote} placeholder="e.g. [beta] wave 1" />
        </label>
        <button class="btn-primary" disabled={busy} onclick={handleGenerate}>Generate</button>
      </div>

      {#if generated.length}
        <div class="generated">
          <p class="warn">
            <strong>Save these codes now — they will not be shown again.</strong>
          </p>
          <ol>
            {#each generated as g (g.license_id)}
              <li><code>{g.code}</code></li>
            {/each}
          </ol>
          <div class="row">
            <button class="btn-primary" onclick={copyAllCodes}>Copy all</button>
            <button class="btn-ghost" onclick={() => (generated = [])}>Dismiss</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="card">
      <h2>Licenses</h2>
      <div class="form-row">
        <input
          type="text"
          placeholder="Search prefix / note / email"
          bind:value={filter}
          onkeydown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button class="btn-ghost" disabled={busy} onclick={handleSearch}>Search</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Tier</th>
              <th>Status</th>
              <th>Claimed by</th>
              <th>Expires</th>
              <th>Note</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each licenses as row (row.license_id)}
              {#if editingId === row.license_id}
                <tr>
                  <td><code>{row.code_prefix}</code></td>
                  <td>
                    <select bind:value={editTier}>
                      <option value="lifetime">lifetime</option>
                      <option value="yearly">yearly</option>
                      <option value="monthly">monthly</option>
                    </select>
                  </td>
                  <td>{row.status}</td>
                  <td>{row.claimed_by_email ?? '—'}</td>
                  <td><input type="date" bind:value={editPeriodEnd} /></td>
                  <td><input type="text" bind:value={editNote} /></td>
                  <td>{formatDate(row.created_at)}</td>
                  <td class="actions">
                    <button class="btn-primary" disabled={busy} onclick={() => saveEdit(row)}>Save</button>
                    <button class="btn-ghost" disabled={busy} onclick={cancelEdit}>Cancel</button>
                  </td>
                </tr>
              {:else}
                <tr>
                  <td><code>{row.code_prefix}</code></td>
                  <td>{row.tier}</td>
                  <td><span class="badge" data-status={row.status}>{row.status}</span></td>
                  <td>{row.claimed_by_email ?? '—'}</td>
                  <td>{formatDate(row.period_end)}</td>
                  <td class="note-cell">{row.note ?? ''}</td>
                  <td>{formatDate(row.created_at)}</td>
                  <td class="actions">
                    <button class="btn-ghost" disabled={busy} onclick={() => startEdit(row)}>Edit</button>
                    {#if row.status !== 'revoked'}
                      <button class="btn-ghost danger" disabled={busy} onclick={() => handleRevoke(row)}>Revoke</button>
                    {/if}
                  </td>
                </tr>
              {/if}
            {/each}
            {#if !licenses.length}
              <tr><td colspan="8" class="empty">No licenses.</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Admins</h2>
      <div class="form-row">
        <input
          type="text"
          placeholder="username, email, or UUID"
          bind:value={newAdminIdentifier}
          onkeydown={(e) => e.key === 'Enter' && !busy && newAdminIdentifier.trim() && handleGrantAdmin()}
        />
        <button class="btn-primary" disabled={busy || !newAdminIdentifier.trim()} onclick={handleGrantAdmin}>Add admin</button>
      </div>
      <ul class="admin-list">
        {#each admins as a (a.user_id)}
          <li>
            <span>{a.email ?? a.user_id}</span>
            <button class="btn-ghost danger" disabled={busy} onclick={() => handleRevokeAdmin(a.user_id)}>Remove</button>
          </li>
        {/each}
      </ul>
    </div>

    {#if status}
      <p class="status" data-kind={statusKind}>{status}</p>
    {/if}
  {/if}
</section>

<style>
  .admin {
    width: min(100% - 2rem, 1100px);
    margin-inline: auto;
    padding: 1rem 0 2rem;
    display: grid;
    gap: 0.9rem;
    color: var(--text);
  }

  h1 { margin: 0; font-size: 1.5rem; font-weight: 700; color: var(--text); }

  .card {
    border: 1px solid color-mix(in oklab, var(--text) 18%, transparent);
    border-radius: 12px;
    padding: 0.85rem 1rem;
    background: var(--surface);
    color: var(--text);
    display: grid;
    gap: 0.7rem;
  }

  h2 { margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--text); }

  .form-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: end;
  }

  .form-row label {
    display: grid;
    gap: 0.2rem;
    font-size: 0.85rem;
    color: var(--text);
  }

  .form-row .grow { flex: 1; min-width: 180px; }

  input, select {
    padding: 0.5rem 0.6rem;
    border: 1px solid color-mix(in oklab, var(--text) 24%, transparent);
    border-radius: 8px;
    font: inherit;
    background: var(--surface);
    color: var(--text);
  }
  input::placeholder { color: var(--muted); }

  button {
    padding: 0.5rem 0.95rem;
    border-radius: 9px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid color-mix(in oklab, var(--text) 22%, transparent);
  }

  .btn-primary {
    background: var(--brand);
    color: #fff;
    border-color: color-mix(in oklab, var(--brand) 75%, black 25%);
  }

  .btn-ghost {
    background: transparent;
    color: var(--text);
  }

  .btn-ghost.danger {
    color: var(--danger, #b22);
    border-color: color-mix(in oklab, var(--danger, #b22) 60%, transparent);
  }

  button:disabled { opacity: 0.5; cursor: not-allowed; }

  .generated {
    display: grid;
    gap: 0.55rem;
  }

  .generated ol {
    margin: 0;
    padding-left: 1.4rem;
    display: grid;
    gap: 0.25rem;
  }

  /* Generated-code chips are intentionally dark on light for max contrast
   * regardless of theme — they're meant to be copied. */
  .generated code {
    font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
    background: #111;
    color: #f1f1f1;
    padding: 0.15rem 0.45rem;
    border-radius: 5px;
    letter-spacing: 0.04em;
    user-select: all;
  }

  .warn {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: color-mix(in oklab, var(--warning, #c80) 22%, var(--surface) 78%);
    border: 1px solid var(--warning, #c80);
    border-radius: 8px;
    color: var(--text);
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    color: var(--text);
  }

  th, td {
    text-align: left;
    padding: 0.4rem 0.55rem;
    border-bottom: 1px solid color-mix(in oklab, var(--text) 12%, transparent);
    vertical-align: middle;
  }

  th {
    font-weight: 700;
    background: color-mix(in oklab, var(--text) 7%, transparent);
  }

  td code {
    font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
    background: color-mix(in oklab, var(--text) 10%, transparent);
    color: var(--text);
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
  }

  td.actions { white-space: nowrap; }
  td.actions button { padding: 0.3rem 0.6rem; font-size: 0.85rem; }

  td.note-cell { max-width: 220px; white-space: pre-wrap; word-break: break-word; }

  .empty { text-align: center; color: var(--muted); padding: 1rem; }

  /* Status badges keep their semantic hues but blend toward the surface so
   * they read on both light and dark backgrounds. */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.5rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 700;
    background: color-mix(in oklab, var(--text) 10%, transparent);
    color: var(--text);
  }

  .badge[data-status='active']    { background: color-mix(in oklab, #2e9c5b 35%, var(--surface) 65%); }
  .badge[data-status='unclaimed'] { background: color-mix(in oklab, var(--text) 12%, transparent); }
  .badge[data-status='expired']   { background: color-mix(in oklab, #e08a3c 40%, var(--surface) 60%); }
  .badge[data-status='revoked']   { background: color-mix(in oklab, #d4524f 38%, var(--surface) 62%); }

  .admin-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.3rem;
  }

  .admin-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.35rem 0.6rem;
    border: 1px solid color-mix(in oklab, var(--text) 14%, transparent);
    border-radius: 8px;
    background: color-mix(in oklab, var(--text) 4%, var(--surface));
    color: var(--text);
  }

  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }

  .status {
    margin: 0;
    font-weight: 600;
  }

  .status[data-kind='success'] { color: var(--success, #2a7); }
  .status[data-kind='error']   { color: var(--danger, #b22); }
  .status[data-kind='info']    { color: var(--muted); }

  .error { color: var(--danger, #b22); font-weight: 600; }
</style>

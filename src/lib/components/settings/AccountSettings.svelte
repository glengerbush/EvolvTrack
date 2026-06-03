<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { dev } from '$app/environment';
  import { bulkUpdateInjections, bulkUpdatePrescriptions, getProfileSyncMode } from '$lib/domain/repo';
  import { db } from '$lib/db/schema';
  import { fromLiveQuery } from '$lib/db/liveQuery';
  import type { InjectionEntry, Medication, Prescription } from '$lib/domain/types';
  import ImportMedicationModal from '$lib/components/settings/ImportMedicationModal.svelte';
  import LicenseSettings from '$lib/components/settings/LicenseSettings.svelte';
  import ThemeTuner from '$lib/components/settings/ThemeTuner.svelte';
  import {
    startE2EEMigration,
    startE2EEDisableMigration,
    startE2EEKeyRotation,
    type E2EEMigrationRunResult,
  } from '$lib/sync/e2ee-migration';
  import { rotateRecoveryCode } from '$lib/sync/recovery-code-rotation';
  import { migrationResumePending } from '$lib/stores/syncStore';
  import RecoveryCodesModal from '$lib/components/settings/RecoveryCodesModal.svelte';
  import DisableE2EEModal from '$lib/components/settings/DisableE2EEModal.svelte';
  import { activeColorMode, activeTabThemes, activeTheme, colorModePreference } from '$lib/stores/themeStore';
  import type { ColorModePreference, ThemeName } from '$lib/theme/dashboardTheme';
  import { weightUnit } from '$lib/stores/unitStore';
  import { isDemoMode } from '$lib/stores/demoStore';
  import { authState } from '$lib/stores/authStore';
  import { clearAllData } from '$lib/domain/repo';
  import { deleteAccountAndClearLocalData, displayUserIdentifier } from '$lib/auth/supabase';
  import { downloadBackup } from '$lib/importExport/backup';
  import { downloadOdsSpreadsheet } from '$lib/importExport/spreadsheet';
  import {
    importResultSummary,
    importTrackingFile,
  } from '$lib/importExport/importer';
  import type { ImportMode } from '$lib/importExport/shared';

  const themeOptions: { value: ThemeName; label: string; hint: string }[] = [
    { value: 'default', label: 'Default', hint: 'Standard color scheme.' },
    { value: 'colorblind', label: 'Color blind', hint: 'Blue, teal, purple, and amber — safe for red-green color blindness.' },
    { value: 'greyscale', label: 'Greyscale', hint: 'No hue, differentiated by lightness only.' },
  ];

  const colorModeOptions: { value: ColorModePreference; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

  /** Optional whitelist of cards to render. When null (the default), every
   *  card is shown. Used by the admin settings surface, which only wants
   *  Appearance and Change password. */
  type Section = 'appearance' | 'units' | 'import' | 'e2ee' | 'password' | 'identity' | 'license' | 'danger';
  let { only = null }: { only?: Section[] | null } = $props();
  const showSection = (name: Section) => !only || only.includes(name);

  // Derive the encryption state from a live query on the profile — the same
  // source the sync pill reads — so the card never goes stale. A login-time
  // `reconcileSyncMode` (server says encrypted, this device was plain) flips the
  // profile under us; reading it once on mount would leave the card showing
  // "disabled" while the pill prompts for an unlock passphrase. (See the
  // matching live query in `syncIndicator.ts`.)
  const profile = fromLiveQuery(() => db.profile.get('profile'), undefined);
  const syncMode = $derived(getProfileSyncMode($profile));
  const e2eeMigration = $derived($profile?.e2eeMigration);
  let e2eeRequested = $state(false);

  // `e2eeRequested` only gates the "create passphrase" form shown while sync is
  // still plain and the user has ticked the box to begin enabling. Once the
  // mode leaves plain (migration started, or reconciled from the server) that
  // request has been consumed, so clear it — otherwise a later disable back to
  // plain would wrongly re-show the enable form.
  $effect(() => {
    if (syncMode !== 'plain') e2eeRequested = false;
  });
  let e2eeBusy = $state(false);
  let passphrase = $state('');
  let passphraseConfirm = $state('');
  let newPassphrase = $state('');
  let newPassphraseConfirm = $state('');
  let username = $state('');
  let email = $state('');
  let currentPassword = $state('');
  let newPassword = $state('');
  let codeToShow = $state<string | null>(null);
  let disableModalOpen = $state(false);
  let disableError = $state<string | null>(null);
  let status = $state('');
  let exportBusy = $state(false);
  let importBusy = $state(false);
  let importMode = $state<ImportMode>('merge');
  let pendingMedFixup = $state<InjectionEntry[]>([]);
  let pendingVialFixup = $state<Prescription[]>([]);

  type ImportStatusKind = 'idle' | 'pending' | 'success' | 'warning' | 'error';
  let importStatus = $state<{ kind: ImportStatusKind; message: string }>({ kind: 'idle', message: '' });

  const passphraseMatch = $derived(!passphraseConfirm || passphrase === passphraseConfirm);
  const newPassphraseMatch = $derived(!newPassphraseConfirm || newPassphrase === newPassphraseConfirm);
  const settingsTheme = $derived($activeTabThemes.settings);
  const e2eeEnabled = $derived(syncMode === 'e2ee');
  const e2eeEnableMigrating = $derived(syncMode === 'migrating_to_e2ee');
  const e2eeDisableMigrating = $derived(syncMode === 'migrating_to_plain');
  const e2eeKeyRotating = $derived(syncMode === 'rotating_e2ee_key');
  // Any migration mid-flight. Import is gated on this: bulk-importing while a
  // migration is paused would pile rows into an outbox that can't drain (sync
  // is paused for the migration's duration), and in the enable case races the
  // plaintext-table teardown.
  const migrationInProgress = $derived(
    e2eeEnableMigrating || e2eeDisableMigrating || e2eeKeyRotating,
  );
  const importBlockedReason = $derived(
    migrationInProgress
      ? 'Import is paused until encryption setup finishes. Resume it in the Encryption section first.'
      : '',
  );
  const e2eeToggleChecked = $derived(syncMode !== 'plain' || e2eeRequested);
  // Locked only while a migration is mid-flight. In steady-state 'e2ee' the
  // checkbox is unlock-able — unchecking opens the confirm-disable modal.
  const e2eeToggleLocked = $derived(
    syncMode === 'migrating_to_e2ee'
      || syncMode === 'migrating_to_plain'
      || syncMode === 'rotating_e2ee_key'
      || e2eeBusy,
  );
  const syncModeLabel = $derived(
    syncMode === 'e2ee'
      ? 'Encrypted'
      : syncMode === 'migrating_to_e2ee'
        ? 'Migration in progress'
        : syncMode === 'migrating_to_plain'
          ? 'Disabling encryption'
        : syncMode === 'rotating_e2ee_key'
          ? 'Rotating encryption key'
        : 'Plain sync'
  );

  function showRecoveryCode(next: string) {
    codeToShow = next;
  }

  function dismissRecoveryCode() {
    // The code is deliberately not persisted in component state. Wiping it
    // when the modal closes means the only way to see it again is to rotate
    // to a fresh one, which invalidates anything written down before.
    codeToShow = null;
  }

  async function generateAndShowRecoveryCodes() {
    if (!passphrase) {
      status = 'Enter your current passphrase to rotate the recovery code.';
      return;
    }
    if (!confirm(
      'Generate a new recovery code? The previous code will stop working.',
    )) return;

    e2eeBusy = true;
    status = 'Rotating recovery code…';
    try {
      const { recoveryCode } = await rotateRecoveryCode(passphrase);
      showRecoveryCode(recoveryCode);
      passphrase = '';
      status = 'Recovery code rotated. Save the new one — the old one no longer works.';
    } catch (error) {
      status = (error as Error).message;
    } finally {
      e2eeBusy = false;
    }
  }

  async function rotateEncryptionKey() {
    if (!passphrase) {
      status = 'Enter your current passphrase to rotate the encryption key.';
      return;
    }
    if (!confirm(
      'Rotate the encryption key? Every record will be re-encrypted under a new key, and you will receive a new recovery code. Your passphrase is unchanged.',
    )) return;

    e2eeBusy = true;
    status = 'Rotating encryption key…';
    try {
      applyMigrationResult(await startE2EEKeyRotation(passphrase));
    } catch (error) {
      status = (error as Error).message;
    } finally {
      e2eeBusy = false;
    }
  }

  function handleE2eeCheckbox(checked: boolean) {
    if (syncMode === 'plain') {
      e2eeRequested = checked;
      if (!checked) { passphrase = ''; passphraseConfirm = ''; }
      return;
    }
    if (syncMode === 'e2ee' && !checked) {
      // Don't flip e2eeRequested yet — the modal collects the passphrase and
      // runs the disable migration on confirm. If the user cancels, the
      // controlled checkbox snaps back to checked on the next render.
      disableError = null;
      disableModalOpen = true;
    }
  }

  function cancelDisableE2EE() {
    if (e2eeBusy) return;
    disableModalOpen = false;
    disableError = null;
  }

  async function confirmDisableE2EE(enteredPassphrase: string) {
    e2eeBusy = true;
    disableError = null;
    status = 'Starting encryption disable...';
    try {
      const result = await startE2EEDisableMigration(enteredPassphrase);
      applyMigrationResult(result);
      // Close the modal whether the disable completed or paused — the relevant
      // UI moves into the migration-status branch and the user can resume there.
      disableModalOpen = false;
    } catch (error) {
      disableError = (error as Error).message;
      status = disableError;
    } finally {
      e2eeBusy = false;
    }
  }

  function applyMigrationResult(result: E2EEMigrationRunResult) {
    // `syncMode` / `e2eeMigration` are derived from the profile live query, so
    // the migration's own `saveProfile` writes drive them — nothing to set here.
    // A completed run clears any "resume needs your passphrase" prompt the
    // orchestrator raised; otherwise the next sync cycle reconciles it.
    if (result.completed) migrationResumePending.set(null);
    if (result.recoveryCode) showRecoveryCode(result.recoveryCode);
    if (result.syncMode === 'plain') codeToShow = null;
    passphrase = '';
    passphraseConfirm = '';

    if (result.completed && result.syncMode === 'plain') {
      status = `E2EE disabled. ${result.pushed} plaintext events uploaded and encrypted sync events were deleted.`;
      return;
    }

    if (result.completed && result.migration.direction === 'rotate') {
      status = `Encryption key rotated. ${result.encryptedEventCount} records re-encrypted and ${result.pushed} sync events pushed.`;
      return;
    }

    if (result.completed) {
      status = `E2EE enabled. ${result.encryptedEventCount} local records encrypted and ${result.pushed} sync events pushed.`;
      return;
    }

    if (result.migration.direction === 'rotate') {
      status = `Key rotation paused. ${result.error ?? 'Resume when you are back online.'}`;
      return;
    }

    status = result.migration.direction === 'disable'
      ? `Encryption disable paused. ${result.error ?? 'Resume when you are back online.'}`
      : `Encryption upgrade paused. ${result.error ?? 'Resume when you are back online.'}`;
  }

  async function enableE2EE() {
    if (passphrase !== passphraseConfirm) { status = 'Passphrases do not match.'; return; }
    e2eeBusy = true;
    status = 'Starting encryption upgrade...';
    try {
      applyMigrationResult(await startE2EEMigration(passphrase));
    } catch (error) {
      status = (error as Error).message;
    } finally {
      e2eeBusy = false;
    }
  }

  function updatePassword() {
    status = 'Password update workflow is not wired yet.';
  }

  async function changePassphrase() {
    if (!passphrase) { status = 'Enter your current passphrase.'; return; }
    if (!newPassphrase) { status = 'Enter a new passphrase.'; return; }
    if (newPassphrase !== newPassphraseConfirm) { status = 'New passphrases do not match.'; return; }

    e2eeBusy = true;
    status = 'Rotating encryption key under new passphrase…';
    try {
      applyMigrationResult(await startE2EEKeyRotation(passphrase, newPassphrase));
      newPassphrase = '';
      newPassphraseConfirm = '';
      passphrase = '';
    } catch (error) {
      status = (error as Error).message;
    } finally {
      e2eeBusy = false;
    }
  }

  function updateIdentity() {
    status = 'Username/email update workflow is not wired yet.';
  }

  async function exportBackupFile() {
    exportBusy = true;
    status = 'Preparing backup...';
    try {
      await downloadBackup();
      status = 'Backup downloaded.';
    } catch (error) {
      status = (error as Error).message;
    } finally {
      exportBusy = false;
    }
  }

  async function exportSpreadsheetFile() {
    exportBusy = true;
    status = 'Preparing ODS spreadsheet...';
    try {
      await downloadOdsSpreadsheet();
      status = 'ODS spreadsheet downloaded.';
    } catch (error) {
      status = (error as Error).message;
    } finally {
      exportBusy = false;
    }
  }

  async function importFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    if (importMode === 'replace' && !confirm('Replace current health, injection, and medication data with this import?')) {
      input.value = '';
      return;
    }

    importBusy = true;
    importStatus = { kind: 'pending', message: 'Reading import…' };
    try {
      const result = await importTrackingFile(file, importMode);
      const warningText = result.warnings.length ? ` ${result.warnings.slice(0, 2).join(' ')}` : '';
      importStatus = {
        kind: result.warnings.length ? 'warning' : 'success',
        message: `${importResultSummary(result)}${warningText}`,
      };
      pendingMedFixup = result.data.injections.filter((injection) => !injection.medication);
      pendingVialFixup = result.data.prescriptions.filter((prescription) => !prescription.type);
    } catch (error) {
      importStatus = { kind: 'error', message: (error as Error).message };
    } finally {
      importBusy = false;
      input.value = '';
    }
  }

  function handleImportFile(event: Event) {
    void importFile(event.currentTarget as HTMLInputElement);
  }

  async function applyMedicationFixup(medication: Medication) {
    const injections = pendingMedFixup;
    const vials = pendingVialFixup;
    pendingMedFixup = [];
    pendingVialFixup = [];
    await Promise.all([
      bulkUpdateInjections(injections.map((i) => i.id), { medication }),
      bulkUpdatePrescriptions(vials.map((v) => v.id), { type: medication }),
    ]);
    const parts: string[] = [];
    if (injections.length) parts.push(`${injections.length} dose${injections.length === 1 ? '' : 's'}`);
    if (vials.length) parts.push(`${vials.length} vial${vials.length === 1 ? '' : 's'}`);
    const label = parts.join(' and ');
    importStatus = {
      kind: importStatus.kind === 'idle' ? 'success' : importStatus.kind,
      message: `${importStatus.message} Set ${label} to ${medication}.`.trim(),
    };
  }

  function dismissMedicationFixup() {
    pendingMedFixup = [];
    pendingVialFixup = [];
  }

  async function exitDemo() {
    // Navigate first so the Dashboard tears down before the demo badge
    // disappears and seeded rows blink out.
    await goto(resolve('/'));
    await isDemoMode.disable();
  }

  let dangerBusy = $state(false);
  const isSignedIn = $derived($authState.kind === 'signed-in');
  const currentIdentifier = $derived(
    $authState.kind === 'signed-in'
      ? displayUserIdentifier($authState.user.email)
      : null,
  );

  async function clearLocalData() {
    if (!confirm('This permanently deletes all data on this device. Continue?')) return;
    dangerBusy = true;
    try {
      await clearAllData();
      status = 'Local data cleared.';
      await goto(resolve('/'));
    } catch (error) {
      status = (error as Error).message;
    } finally {
      dangerBusy = false;
    }
  }

  async function deleteAccount() {
    const user = $authState.kind === 'signed-in' ? $authState.user : null;
    if (!user) {
      status = 'You must be signed in to delete your account.';
      return;
    }
    // Type-to-confirm: ask the user to type the local part of their email
    // (username for username-only accounts). Avoids accidental destruction
    // from a mis-click on a single OK button.
    const email = user.email ?? '';
    const handle = email.split('@')[0] ?? '';
    if (!handle) {
      status = 'Could not determine your account identifier. Contact support.';
      return;
    }
    const typed = window.prompt(
      `Permanently delete your account and all synced data.\n\n` +
      `This is irreversible. Your license (if any) becomes unclaimed and the ` +
      `code is unrecoverable.\n\n` +
      `Type "${handle}" to confirm.`,
      '',
    );
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== handle.toLowerCase()) {
      status = 'Confirmation text did not match. Account not deleted.';
      return;
    }

    dangerBusy = true;
    status = 'Deleting account…';
    try {
      await deleteAccountAndClearLocalData();
      // The cleanup wipes local state; navigate to the landing page.
      window.location.href = '/';
    } catch (error) {
      status = `Could not delete account: ${(error as Error).message}`;
    } finally {
      dangerBusy = false;
    }
  }

</script>

<section
  class="settings-panel"
  style:--cardBorder={settingsTheme.cardBorder}
  style:--headerBg={settingsTheme.headerBg}
  style:--headerText={settingsTheme.headerText}
>
  <h1>Account Settings</h1>

  {#if $isDemoMode}
    <div class="demo-notice">
      <strong>Demo mode</strong> — data is local only and resets when you clear your browser.
      <button type="button" class="exit-demo-btn" onclick={exitDemo}>Exit Demo</button>
    </div>
  {/if}

  {#if showSection('appearance')}
  <div class="card-wrap">
    <h2>{showSection('units') ? 'Appearance & Units' : 'Appearance'}</h2>
    <div class="panel">
      <p class="theme-label">Color theme</p>
      <div class="theme-selector" role="group" aria-label="Color theme">
        {#each themeOptions as opt (opt.value)}
          <button
            type="button"
            class="theme-btn"
            class:selected={$activeTheme === opt.value}
            onclick={() => activeTheme.set(opt.value)}
          >{opt.label}</button>
        {/each}
      </div>
      <p class="toggle-hint">{themeOptions.find(o => o.value === $activeTheme)?.hint ?? ''}</p>

      <p class="theme-label" style="margin-top:0.8rem">Appearance</p>
      <div class="theme-selector" role="group" aria-label="Appearance">
        {#each colorModeOptions as opt (opt.value)}
          <button
            type="button"
            class="theme-btn"
            class:selected={$colorModePreference === opt.value}
            onclick={() => colorModePreference.set(opt.value)}
          >{opt.label}</button>
        {/each}
      </div>
      <p class="toggle-hint">
        {#if $colorModePreference === 'system'}
          Following your OS — currently {$activeColorMode}.
        {:else}
          Override active. Pick System to follow your OS.
        {/if}
      </p>

      {#if showSection('units')}
        <p class="theme-label" style="margin-top:0.8rem">Weight unit</p>
        <div class="theme-selector" role="group" aria-label="Weight unit">
          <button
            type="button"
            class="theme-btn"
            class:selected={$weightUnit === 'lbs'}
            onclick={() => weightUnit.set('lbs')}
          >lbs</button>
          <button
            type="button"
            class="theme-btn"
            class:selected={$weightUnit === 'kg'}
            onclick={() => weightUnit.set('kg')}
          >kg</button>
        </div>
      {/if}

      {#if dev}
        <ThemeTuner />
      {/if}
    </div>
  </div>
  {/if}

  {#if showSection('import')}
  <div class="card-wrap">
    <h2>Import / Export</h2>
    <div class="panel">
      <div class="data-grid">
        <div class="data-block">
          <p class="theme-label">Backup</p>
          <button class="btn btn-primary" disabled={exportBusy} onclick={exportBackupFile}>Download JSON backup</button>
        </div>

        <div class="data-block">
          <p class="theme-label">Spreadsheet</p>
          <button class="btn btn-primary" disabled={exportBusy} onclick={exportSpreadsheetFile}>Download ODS spreadsheet</button>
          <a
            class="libre-link"
            href="https://www.libreoffice.org/download/download-libreoffice/"
            target="_blank"
            rel="noreferrer"
          >LibreOffice</a>
        </div>

        <div class="data-block data-block-wide">
          <p class="theme-label">Import</p>
          <div class="theme-selector" role="group" aria-label="Import mode">
            <button
              type="button"
              class="theme-btn"
              class:selected={importMode === 'merge'}
              onclick={() => importMode = 'merge'}
            >Merge</button>
            <button
              type="button"
              class="theme-btn"
              class:selected={importMode === 'replace'}
              onclick={() => importMode = 'replace'}
            >Replace</button>
          </div>
          <div class="import-row">
            <label
              class="file-picker"
              class:file-picker--disabled={migrationInProgress}
              title={importBlockedReason || undefined}
            >
              <input
                type="file"
                accept=".json,.csv,.tsv,.txt,.ods,.xlsx,application/json,text/csv,application/vnd.oasis.opendocument.spreadsheet,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                disabled={importBusy || migrationInProgress}
                onchange={handleImportFile}
              />
              <span>{importBusy ? 'Importing...' : 'Choose file'}</span>
            </label>
            {#if importStatus.kind !== 'idle'}
              <span
                class="import-status import-status--{importStatus.kind}"
                role="status"
                aria-live="polite"
              >{importStatus.message}</span>
            {/if}
          </div>
          {#if migrationInProgress}
            <p class="import-blocked-hint" role="status">{importBlockedReason}</p>
          {/if}
          <p class="toggle-hint">
            We can import data from most tracking apps that export common formats like CSV, JSON, ODS, or XLSX.
          </p>

          <details class="import-help">
            <summary>Importing your own spreadsheet</summary>
            <div class="import-help-body">
              <p>
                <strong>Easiest route:</strong> use the <em>Download ODS spreadsheet</em> button above as a
                template. Open it, type your data into the rows under the existing column headers, save, then
                import it back here. The column names already match, so everything lines up.
              </p>

              <p>
                <strong>Adapting your own sheet?</strong> The importer reads each sheet by its column headers,
                so the headers have to match the names below. Capitalisation, spaces, and punctuation are
                ignored — but the words must match. For example <code>Dose</code> or <code>Dose (mg)</code> is
                recognised; <code>Dose Added</code> is not.
              </p>

              <ul>
                <li>The header row is the first row with at least two filled-in cells.</li>
                <li>Every row needs a recognisable <strong>Date</strong> — rows without one are skipped.</li>
                <li>A dose only becomes a logged injection if it is greater than 0.</li>
                <li>
                  Medication must be a known GLP-1 name (Semaglutide/Ozempic/Wegovy,
                  Tirzepatide/Mounjaro/Zepbound, Dulaglutide/Trulicity, Liraglutide/Victoza/Saxenda,
                  Retatrutide). Other names are dropped.
                </li>
                <li>For weight in kilograms, include “kg” in the column header (e.g. <code>Weight (kg)</code>).</li>
                <li>
                  Start weight, goal weight, and other settings are <strong>not</strong> read from a custom
                  spreadsheet — only from an EvolvTrack export or JSON backup. Set those in the app after
                  importing.
                </li>
              </ul>

              <p class="import-help-heading">Accepted column names</p>
              <dl>
                <dt>Date</dt>
                <dd>Date, Shot Date, Injection Date, Dose Date, Taken At, Logged At, Time, Timestamp</dd>
                <dt>Weight</dt>
                <dd>Weight, Body Weight, Current Weight, Weight (lbs), Weight (kg)</dd>
                <dt>Dose</dt>
                <dd>Dose, Dose (mg), Dosage, Amount, Amount (mg), Quantity, Units</dd>
                <dt>Medication</dt>
                <dd>Medication, Medicine, Drug, Peptide, Compound, Type</dd>
                <dt>Injection site</dt>
                <dd>Shot Location, Injection Site, Site, Location, Body Site</dd>
                <dt>Wellness</dt>
                <dd>Wellness, Wellness Score, Mood, Feeling, Check-in Score</dd>
                <dt>Symptoms</dt>
                <dd>Symptoms, Side Effects, Effects</dd>
                <dt>Notes</dt>
                <dd>Notes, Comments, Reflection, Details</dd>
                <dt>Status</dt>
                <dd>Status, Planned, Confirmed, Taken, Completed</dd>
                <dt>Medication / vial sheet</dt>
                <dd>
                  Type, Concentration (mg/mL), Additive, mL in Vial, Prescribed Dosage, Doses Left,
                  Compound Date, BUD, Pharmacy, Lot Number, Cost
                </dd>
              </dl>
            </div>
          </details>
        </div>
      </div>
    </div>
  </div>
  {/if}

  {#if showSection('e2ee')}
  <div class="card-wrap">
    <h2>End-to-end encryption (E2EE)</h2>
    <div class="panel">
      {#if $isDemoMode}
        <p class="demo-block-msg">E2EE cannot be enabled in Demo mode. <a href={resolve('/auth')}>Create an account</a> to enable encryption.</p>
      {:else}
        <div class="sync-mode-row">
          <span class="sync-mode-pill" data-mode={syncMode}>{syncModeLabel}</span>
          {#if e2eeMigration?.updatedAt}
            <span class="sync-mode-meta">updated {new Date(e2eeMigration.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
          {/if}
        </div>
        <label class="e2ee-toggle">
          <input
            type="checkbox"
            checked={e2eeToggleChecked}
            disabled={e2eeToggleLocked}
            onchange={(e) => handleE2eeCheckbox(e.currentTarget.checked)}
          />
          Enable end-to-end encryption
        </label>
        <div class="backup-reminder">
          <p class="toggle-hint">
            <strong>Tip:</strong> download a backup from <em>Import / Export</em> above before
            changing encryption settings — there's no undo for a stuck migration.
          </p>
        </div>

        {#if e2eeRequested && syncMode === 'plain'}
          <label>Passphrase<input bind:value={passphrase} type="password" placeholder="Create passphrase" /></label>
          <label>
            Confirm passphrase
            <input bind:value={passphraseConfirm} type="password" placeholder="Confirm passphrase" class:mismatch={!passphraseMatch} />
            {#if !passphraseMatch}<span class="field-error">Passphrases do not match</span>{/if}
          </label>
          <button class="btn btn-primary" disabled={e2eeBusy || !passphrase || !passphraseMatch} onclick={enableE2EE}>
            {e2eeBusy ? 'Starting...' : 'Enable E2EE + generate recovery code'}
          </button>
        {:else if migrationInProgress}
          <div class="migration-status">
            <p class="toggle-hint">
              {e2eeEnableMigrating
                ? 'Encryption setup is in progress.'
                : e2eeDisableMigrating
                  ? 'Turning off encryption is in progress.'
                  : 'Key rotation is in progress.'}
              Steady-state sync is paused until it finishes — follow the prompt
              on screen to complete or resume it.
            </p>
          </div>
        {:else if e2eeEnabled}
          <label>Current passphrase<input bind:value={passphrase} type="password" placeholder="Current passphrase" autocomplete="current-password" /></label>
          <div class="recovery-row">
            <button class="btn btn-ghost" type="button" disabled={e2eeBusy || !passphrase} onclick={generateAndShowRecoveryCodes}>
              Rotate recovery code
            </button>
            <p class="toggle-hint">
              Use if your recovery code may have been seen. Issues a fresh code; the old one stops working immediately. Your encryption key is unchanged.
            </p>
          </div>
          <div class="recovery-row">
            <button class="btn btn-ghost" type="button" disabled={e2eeBusy || !passphrase} onclick={rotateEncryptionKey}>
              Rotate encryption key
            </button>
            <p class="toggle-hint">
              Use if a device may have been compromised. Mints a new encryption key, re-encrypts every record, and issues a fresh recovery code. Your passphrase is unchanged. Data captured before the rotation stays decryptable with the old key, but future data is safe.
            </p>
          </div>
          <label>New passphrase<input bind:value={newPassphrase} type="password" placeholder="New passphrase" autocomplete="new-password" /></label>
          <label>
            Confirm new passphrase
            <input bind:value={newPassphraseConfirm} type="password" placeholder="Confirm new passphrase" class:mismatch={!newPassphraseMatch} autocomplete="new-password" />
            {#if !newPassphraseMatch}<span class="field-error">Passphrases do not match</span>{/if}
          </label>
          <button class="btn btn-primary" disabled={e2eeBusy || !passphrase || !newPassphrase || !newPassphraseMatch} onclick={changePassphrase}>
            {e2eeBusy ? 'Rotating…' : 'Rotate passphrase'}
          </button>
        {/if}
      {/if}
    </div>
  </div>
  {/if}

  {#if showSection('password') && !$isDemoMode}
    <div class="card-wrap">
      <h2>Change login password</h2>
      <div class="panel">
        <label>Current password<input bind:value={currentPassword} type="password" placeholder="Current password" /></label>
        <label>New password<input bind:value={newPassword} type="password" placeholder="New password" /></label>
        <button class="btn btn-primary" onclick={updatePassword}>Update password</button>
      </div>
    </div>
  {/if}

  {#if showSection('identity') && !$isDemoMode}
    <div class="card-wrap">
      <h2>Change username / email</h2>
      <div class="panel">
        {#if currentIdentifier}
          <p class="toggle-hint">
            Currently signed in as <strong>{currentIdentifier}</strong>
          </p>
        {/if}
        <label>Username<input bind:value={username} type="text" placeholder="New username" /></label>
        <label>Email<input bind:value={email} type="email" placeholder="New email" /></label>
        <button class="btn btn-primary" onclick={updateIdentity}>Update account identity</button>
      </div>
    </div>
  {/if}

  {#if showSection('license') && !$isDemoMode}
    <LicenseSettings />
  {/if}

  {#if showSection('danger') && !$isDemoMode}
    <div class="card-wrap">
      <h2>{isSignedIn ? 'Delete account' : 'Clear local data'}</h2>
      <div class="panel danger-panel">
        {#if isSignedIn}
          <p class="toggle-hint">
            Deletes your EvolvTrack account and all synced data. This cannot be undone.
          </p>
          <button
            class="btn btn-danger"
            type="button"
            disabled={dangerBusy}
            onclick={deleteAccount}
          >{dangerBusy ? 'Deleting…' : 'Delete account'}</button>
        {:else}
          <p class="toggle-hint">
            Wipes every weight, dose, and prescription stored on this device.
            This cannot be undone — download a backup first if you might want this data back.
          </p>
          <button
            class="btn btn-danger"
            type="button"
            disabled={dangerBusy}
            onclick={clearLocalData}
          >{dangerBusy ? 'Clearing…' : 'Clear local data'}</button>
        {/if}
      </div>
    </div>
  {/if}

  <small>{status}</small>
</section>

{#if pendingMedFixup.length || pendingVialFixup.length}
  <ImportMedicationModal
    doseCount={pendingMedFixup.length}
    vialCount={pendingVialFixup.length}
    onConfirm={applyMedicationFixup}
    onCancel={dismissMedicationFixup}
  />
{/if}

{#if codeToShow}
  <RecoveryCodesModal code={codeToShow} onClose={dismissRecoveryCode} />
{/if}

{#if disableModalOpen}
  <DisableE2EEModal
    busy={e2eeBusy}
    error={disableError}
    onConfirm={confirmDisableE2EE}
    onCancel={cancelDisableE2EE}
  />
{/if}

<style>
  .settings-panel {
    width: min(100% - 2rem, 720px);
    margin-inline: auto;
    padding: 1rem 0 1.25rem;
    display: grid;
    gap: 0.8rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
    font-variant: small-caps;
    color: var(--headerText);
    background: color-mix(in oklab, var(--headerBg) 92%, white 8%);
    border: 2px solid var(--cardBorder);
    border-radius: 14px;
    padding: 0.45rem 1rem 0.5rem;
  }

  .demo-notice {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    background: color-mix(in oklab, var(--warning) 18%, white 82%);
    border: 2px solid var(--warning);
    border-radius: 12px;
    padding: 0.65rem 0.9rem;
    font-size: 0.95rem;
    color: #3a2000;
  }

  .exit-demo-btn {
    margin-left: auto;
    border: 2px solid color-mix(in oklab, var(--warning) 70%, black 30%);
    border-radius: 8px;
    background: transparent;
    color: color-mix(in oklab, var(--warning) 40%, black 60%);
    font-weight: 600;
    font-size: 0.9rem;
    padding: 0.25rem 0.75rem;
    cursor: pointer;
    opacity: 1;
  }

  .exit-demo-btn:hover {
    background: color-mix(in oklab, var(--warning) 20%, transparent 80%);
  }

  .demo-block-msg {
    margin: 0;
    font-size: 0.95rem;
    color: #555;
  }

  .demo-block-msg a {
    color: var(--cardBorder);
    text-decoration: underline;
  }

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
    border: 2px solid var(--cardBorder);
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
    border: 4px solid var(--cardBorder);
    border-radius: 0 14px 14px 14px;
    padding: 0.8rem;
    background: color-mix(in oklab, var(--surface) 86%, transparent);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.16);
  }

  input {
    padding: 0.7rem;
    border: 2px solid color-mix(in oklab, var(--cardBorder) 60%, white 40%);
    border-radius: 10px;
    display: block;
    width: min(100%, 380px);
    font: inherit;
  }

  input:focus {
    outline: none;
    border-color: var(--cardBorder);
  }

  input.mismatch {
    border-color: var(--danger);
  }

  .field-error {
    display: block;
    font-size: 0.83rem;
    color: var(--danger);
    margin-top: 0.2rem;
  }

  ul {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    padding-left: 1rem;
  }

  .recovery-row {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    align-items: flex-start;
    margin-bottom: 0.4rem;
    border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 24%, transparent 76%);
    padding-bottom: 0.5rem;
  }

  small {
    color: #555;
  }

  button {
    opacity: 0.8;
    border-radius: 11px;
  }

  .settings-panel .btn-primary {
    background: var(--headerBg);
    color: var(--headerText);
    border: 2px solid var(--cardBorder);
    opacity: 1;
  }

  .settings-panel .btn-ghost {
    background: color-mix(in oklab, var(--headerBg) 14%, var(--surface) 86%);
    color: var(--text);
    border: 2px solid color-mix(in oklab, var(--cardBorder) 65%, var(--surface) 35%);
    opacity: 1;
  }

  .settings-panel .btn:disabled,
  .file-picker input:disabled + span {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .settings-panel .btn-danger {
    background: color-mix(in oklab, var(--danger, #b91c1c) 88%, white 12%);
    color: white;
    border: 2px solid color-mix(in oklab, var(--danger, #b91c1c) 70%, black 30%);
    opacity: 1;
    width: fit-content;
  }

  .danger-panel {
    border-color: color-mix(in oklab, var(--danger, #b91c1c) 70%, var(--cardBorder) 30%);
  }

  .theme-label {
    margin: 0 0 0.4rem;
    font-weight: 600;
    font-size: 1rem;
  }

  .theme-selector {
    display: flex;
    gap: 0;
    border: 2px solid color-mix(in oklab, var(--cardBorder) 50%, #ccc 50%);
    border-radius: 11px;
    overflow: hidden;
    width: fit-content;
  }

  .theme-btn {
    border: 0;
    border-radius: 0;
    padding: 0.45rem 1rem;
    font-size: 0.95rem;
    font-weight: 500;
    background: #f0f0f0;
    color: #444;
    cursor: pointer;
    opacity: 1;
    transition: background 150ms, color 150ms;
  }

  .theme-btn + .theme-btn {
    border-left: 2px solid color-mix(in oklab, var(--cardBorder) 40%, #ccc 60%);
  }

  .theme-btn.selected {
    background: var(--headerBg);
    color: var(--headerText);
  }

  .toggle-hint {
    margin: 0.35rem 0 0;
    font-size: 0.88rem;
    color: #666;
  }

  .file-picker--disabled {
    cursor: not-allowed;
  }

  .import-blocked-hint {
    margin: 0.4rem 0 0;
    font-size: 0.88rem;
    font-weight: 500;
    color: color-mix(in oklab, var(--danger, #b91c1c) 70%, var(--text) 30%);
  }

  .import-help {
    margin-top: 0.5rem;
    font-size: 0.88rem;
    color: #666;
  }

  .import-help > summary {
    cursor: pointer;
    width: fit-content;
    font-weight: 600;
    color: var(--cardBorder);
    text-underline-offset: 0.18rem;
  }

  .import-help > summary:hover {
    text-decoration: underline;
  }

  .import-help-body {
    margin-top: 0.5rem;
    display: grid;
    gap: 0.5rem;
    line-height: 1.5;
    /* The drug-name lists are slash-joined with no spaces (e.g.
     * "Tirzepatide/Mounjaro/Zepbound"), so they form one long unbreakable token.
     * As a grid item's min-content that pushed the whole page sideways on a
     * phone. Let the long tokens wrap and let the nested grid tracks shrink. */
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .import-help-body > * {
    min-width: 0;
  }

  .import-help-body p {
    margin: 0;
  }

  .import-help-body ul {
    margin: 0;
    padding-left: 1.1rem;
    display: grid;
    /* Override the bare `ul` rule above (a 2-column grid meant for short lists):
     * these are long prose bullets, unreadable in a 2nd ~140px column on a
     * phone, so force a single column. */
    grid-template-columns: 1fr;
    gap: 0.3rem;
  }

  .import-help-heading {
    margin-top: 0.2rem;
    font-weight: 600;
    color: #444;
  }

  .import-help-body dl {
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .import-help-body dt {
    font-weight: 600;
    color: #444;
  }

  .import-help-body dd {
    margin: 0.05rem 0 0;
  }

  .import-help-body code {
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    background: #f0f0f0;
    font-size: 0.85em;
  }

  .data-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .data-block {
    display: grid;
    align-content: start;
    gap: 0.55rem;
    min-width: 0;
  }

  .data-block-wide {
    grid-column: 1 / -1;
  }

  .libre-link {
    width: fit-content;
    color: var(--cardBorder);
    font-weight: 700;
    font-size: 0.92rem;
    text-decoration: underline;
    text-underline-offset: 0.18rem;
  }

  .import-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem 0.8rem;
  }

  .import-status {
    font-size: 0.92rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .import-status--pending {
    color: #475569;
  }

  .import-status--success {
    color: var(--success);
  }

  .import-status--warning {
    color: var(--warning);
  }

  .import-status--error {
    color: var(--danger);
  }

  .file-picker {
    position: relative;
    display: inline-flex;
    width: fit-content;
    cursor: pointer;
  }

  .file-picker input {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
    cursor: pointer;
  }

  .file-picker span {
    display: inline-flex;
    align-items: center;
    min-height: 2.7rem;
    border-radius: 999px;
    background: var(--headerBg);
    color: var(--headerText);
    border: 2px solid var(--cardBorder);
    font-weight: 700;
    padding: 0.72rem 1.2rem;
  }

  .sync-mode-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .sync-mode-pill {
    display: inline-flex;
    align-items: center;
    min-height: 1.9rem;
    border: 2px solid var(--cardBorder);
    border-radius: 999px;
    padding: 0.18rem 0.72rem;
    font-size: 0.85rem;
    font-weight: 800;
    background: color-mix(in oklab, var(--headerBg) 14%, white 86%);
    color: #253024;
  }

  .sync-mode-pill[data-mode='e2ee'] {
    background: color-mix(in oklab, var(--success) 18%, white 82%);
    border-color: var(--success);
  }

  .sync-mode-pill[data-mode='migrating_to_e2ee'] {
    background: color-mix(in oklab, var(--warning) 20%, white 80%);
    border-color: var(--warning);
  }

  .sync-mode-pill[data-mode='migrating_to_plain'] {
    background: color-mix(in oklab, var(--danger) 16%, white 84%);
    border-color: var(--danger);
  }

  .sync-mode-meta {
    color: #666;
    font-size: 0.83rem;
  }

  .migration-status {
    display: grid;
    gap: 0.35rem;
  }

  .backup-reminder {
    display: grid;
    gap: 0.45rem;
    justify-items: start;
    border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 24%, transparent 76%);
    padding-bottom: 0.5rem;
    margin-bottom: 0.4rem;
  }

  .e2ee-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
  }

  .e2ee-toggle input[type='checkbox'] {
    width: 1.15rem;
    height: 1.15rem;
    padding: 0;
    display: inline;
    accent-color: var(--cardBorder);
    cursor: pointer;
  }

  .e2ee-toggle input[type='checkbox']:disabled {
    cursor: default;
    opacity: 0.7;
  }

  @media (max-width: 560px) {
    .data-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

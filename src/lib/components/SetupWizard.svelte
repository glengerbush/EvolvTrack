<script lang="ts">
  import { onMount } from 'svelte';
  import { setupWizardPending } from '$lib/stores/setupWizardStore';
  import { startE2EEMigration } from '$lib/sync/e2ee-migration';
  import BackupButton from '$lib/components/settings/BackupButton.svelte';
  import { importTrackingFile, importResultSummary } from '$lib/importExport/importer';
  import { requestSync } from '$lib/sync/sync-orchestrator';
  import { claimLicense, fetchLicenseStatus, type LicenseStatusRow } from '$lib/sync/license';
  import { bulkUpdateInjections, bulkUpdatePrescriptions } from '$lib/domain/repo';
  import { MEDICATIONS, type Medication, type InjectionEntry, type Prescription } from '$lib/domain/types';

  type Step = 'license' | 'e2ee' | 'import' | 'medication' | 'done';

  let step = $state<Step>('license');
  let busy = $state(false);

  // License step
  let licenseLoading = $state(true);
  let licenseStatus = $state<LicenseStatusRow | null>(null);
  let licenseCode = $state('');
  let licenseMessage = $state('');

  // E2EE step
  let passphrase = $state('');
  let passphraseConfirm = $state('');
  let e2eeStatus = $state('');
  let recoveryCode = $state<string | null>(null);

  // Import step
  let importStatus = $state('');
  // Set when the E2EE enable above didn't finish (paused). Importing while a
  // migration is mid-flight would queue rows that can't sync until it
  // completes, so the import step is gated until the user resumes from Settings.
  let migrationPaused = $state(false);
  let injectionsMissingMed = $state<string[]>([]);
  let prescriptionsMissingMed = $state<string[]>([]);
  let pickedMedication = $state<Medication | ''>('');

  const missingMedSummary = $derived.by(() => {
    const parts: string[] = [];
    if (injectionsMissingMed.length) {
      parts.push(`${injectionsMissingMed.length} injection${injectionsMissingMed.length === 1 ? '' : 's'}`);
    }
    if (prescriptionsMissingMed.length) {
      parts.push(`${prescriptionsMissingMed.length} vial${prescriptionsMissingMed.length === 1 ? '' : 's'}`);
    }
    return parts.join(' and ');
  });
  const totalMissingMed = $derived(injectionsMissingMed.length + prescriptionsMissingMed.length);

  const passphraseMatch = $derived(!passphraseConfirm || passphrase === passphraseConfirm);
  const hasActiveLicense = $derived(!!licenseStatus?.is_active);
  const canEnableE2EE = $derived(
    !busy && hasActiveLicense && passphrase.length > 0 && passphrase === passphraseConfirm,
  );

  onMount(() => {
    void refreshLicense();
  });

  async function refreshLicense() {
    licenseLoading = true;
    try {
      licenseStatus = await fetchLicenseStatus();
    } catch (error) {
      licenseMessage = (error as Error).message;
    } finally {
      licenseLoading = false;
    }
  }

  function finish() {
    setupWizardPending.clear();
    // Now that the wizard is dismissed, the orchestrator will start pushing.
    requestSync();
  }

  function close() {
    finish();
  }

  async function handleClaim() {
    if (!licenseCode.trim()) {
      licenseMessage = 'Enter a license code.';
      return;
    }
    busy = true;
    licenseMessage = 'Claiming license…';
    try {
      await claimLicense(licenseCode);
      licenseCode = '';
      await refreshLicense();
      licenseMessage = 'License claimed.';
      step = 'e2ee';
    } catch (error) {
      licenseMessage = (error as Error).message;
    } finally {
      busy = false;
    }
  }

  function skipLicense() {
    // E2EE is only useful with a license (cloud sync is what gets encrypted),
    // so skipping the license step also skips E2EE.
    step = hasActiveLicense ? 'e2ee' : 'import';
  }

  async function enableE2EE() {
    if (!canEnableE2EE) return;
    busy = true;
    e2eeStatus = 'Enabling encryption…';
    try {
      const result = await startE2EEMigration(passphrase);
      if (result.recoveryCode) recoveryCode = result.recoveryCode;
      migrationPaused = !result.completed;
      if (result.completed) {
        e2eeStatus = `Encryption enabled. ${result.encryptedEventCount} local record${result.encryptedEventCount === 1 ? '' : 's'} encrypted.`;
      } else {
        e2eeStatus = result.error
          ? `Encryption setup paused: ${result.error} You can resume from Settings.`
          : 'Encryption setup paused. You can resume from Settings.';
      }
      passphrase = '';
      passphraseConfirm = '';
      // Stay on the e2ee step so the user sees the recovery code (if any).
      // They confirm with "Continue" below, which advances to import.
      if (!recoveryCode) step = 'import';
    } catch (error) {
      e2eeStatus = (error as Error).message;
    } finally {
      busy = false;
    }
  }

  function skipE2EE() {
    step = 'import';
  }

  function acknowledgeRecoveryCodes() {
    step = 'import';
  }

  async function handleImportFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    busy = true;
    importStatus = 'Reading import…';
    try {
      const result = await importTrackingFile(file, 'merge');
      const warningText = result.warnings.length ? ` ${result.warnings.slice(0, 2).join(' ')}` : '';
      importStatus = `${importResultSummary(result)}${warningText}`;

      const missingIds = result.data.injections
        .filter((entry: InjectionEntry) => !entry.medication)
        .map((entry: InjectionEntry) => entry.id);
      const missingVialIds = result.data.prescriptions
        .filter((entry: Prescription) => !entry.type)
        .map((entry: Prescription) => entry.id);
      if (missingIds.length > 0 || missingVialIds.length > 0) {
        injectionsMissingMed = missingIds;
        prescriptionsMissingMed = missingVialIds;
        step = 'medication';
      }
    } catch (error) {
      importStatus = (error as Error).message;
    } finally {
      busy = false;
      input.value = '';
    }
  }

  function skipImport() {
    step = 'done';
  }

  async function applyMedication() {
    if (!pickedMedication) return;
    if (injectionsMissingMed.length === 0 && prescriptionsMissingMed.length === 0) return;
    busy = true;
    try {
      await Promise.all([
        bulkUpdateInjections(injectionsMissingMed, { medication: pickedMedication }),
        bulkUpdatePrescriptions(prescriptionsMissingMed, { type: pickedMedication }),
      ]);
      const parts: string[] = [];
      if (injectionsMissingMed.length) {
        parts.push(`${injectionsMissingMed.length} injection${injectionsMissingMed.length === 1 ? '' : 's'}`);
      }
      if (prescriptionsMissingMed.length) {
        parts.push(`${prescriptionsMissingMed.length} vial${prescriptionsMissingMed.length === 1 ? '' : 's'}`);
      }
      importStatus = `Set medication on ${parts.join(' and ')}.`;
      injectionsMissingMed = [];
      prescriptionsMissingMed = [];
      step = 'done';
    } catch (error) {
      importStatus = (error as Error).message;
    } finally {
      busy = false;
    }
  }

  function skipMedicationPick() {
    injectionsMissingMed = [];
    prescriptionsMissingMed = [];
    step = 'done';
  }

  let copyLabel = $state('Copy');
  async function copyRecoveryCode() {
    if (!recoveryCode) return;
    try {
      await navigator.clipboard.writeText(recoveryCode);
      copyLabel = 'Copied!';
      setTimeout(() => (copyLabel = 'Copy'), 1800);
    } catch {
      copyLabel = 'Copy failed';
      setTimeout(() => (copyLabel = 'Copy'), 1800);
    }
  }
</script>

<div class="wizard-backdrop" role="presentation">
  <div
    class="wizard"
    role="dialog"
    aria-modal="true"
    aria-labelledby="setup-wizard-title"
  >
    <header class="wizard-header">
      <h2 id="setup-wizard-title">Welcome to EvolvTrack</h2>
      <button class="close-btn" type="button" aria-label="Close setup wizard" onclick={close}>×</button>
    </header>

    <p class="wizard-note">Everything in this wizard is also available later within Settings.</p>

    {#if step === 'license'}
      <div class="wizard-body">
        <h3>License code</h3>
        <p>
          Cloud sync is gated by a license. If you have a code, paste it here.
          If not, you can skip this and claim a code later — your data still
          works locally without one.
        </p>

        {#if licenseLoading}
          <p class="status">Checking license…</p>
        {:else if hasActiveLicense}
          <p class="status success">You already have an active license. Continue.</p>
        {:else}
          <label>
            License code
            <input
              bind:value={licenseCode}
              type="text"
              autocomplete="off"
              spellcheck="false"
              disabled={busy}
              placeholder="EVT-XXXX-XXXX-XXXX"
            />
          </label>
        {/if}

        {#if licenseMessage}<p class="status" role="status">{licenseMessage}</p>{/if}
      </div>
      <footer class="wizard-footer">
        <button class="btn btn-ghost" type="button" onclick={skipLicense} disabled={busy}>
          {hasActiveLicense ? 'Continue' : "I don't have one — skip"}
        </button>
        {#if !hasActiveLicense}
          <button
            class="btn btn-primary"
            type="button"
            onclick={handleClaim}
            disabled={busy || licenseLoading || !licenseCode.trim()}
          >
            {busy ? 'Claiming…' : 'Claim'}
          </button>
        {:else}
          <button class="btn btn-primary" type="button" onclick={skipLicense}>Next</button>
        {/if}
      </footer>
    {:else if step === 'e2ee'}
      <div class="wizard-body">
        <h3>End-to-end encryption</h3>

        {#if recoveryCode}
          <p>{e2eeStatus}</p>
          <div class="recovery">
            <h4>Recovery code</h4>
            <p class="hint">
              Save this now — it's the only way to decrypt your data if you
              forget your passphrase. It won't be shown again.
            </p>
            <p class="code"><code>{recoveryCode}</code></p>
            <button class="btn btn-ghost copy-btn" type="button" onclick={copyRecoveryCode}>
              {copyLabel}
            </button>
          </div>
        {:else}
          <p>
            Encrypts everything that leaves this device with a passphrase only you
            know. We can't recover the passphrase if you lose it — you'll get a
            recovery code after enabling.
          </p>

          <p class="hint">
            After entering a license code, you will be given the option for end to end encryption before the first cloud sync.
          </p>

          <label>
            Passphrase
            <input bind:value={passphrase} type="password" autocomplete="new-password" />
          </label>
          <label>
            Confirm passphrase
            <input
              bind:value={passphraseConfirm}
              type="password"
              autocomplete="new-password"
              class:mismatch={!passphraseMatch}
            />
            {#if !passphraseMatch}
              <span class="field-error">Passphrases do not match</span>
            {/if}
          </label>

          {#if e2eeStatus}<p class="status" role="status">{e2eeStatus}</p>{/if}

          <div class="backup-slot">
            <BackupButton compact />
          </div>
        {/if}
      </div>
      <footer class="wizard-footer">
        {#if recoveryCode}
          <button class="btn btn-primary" type="button" onclick={acknowledgeRecoveryCodes}>
            I've saved my code — continue
          </button>
        {:else}
          <button class="btn btn-ghost" type="button" onclick={skipE2EE} disabled={busy}>
            Skip for now
          </button>
          <button class="btn btn-primary" type="button" onclick={enableE2EE} disabled={!canEnableE2EE}>
            {busy ? 'Enabling…' : 'Enable encryption'}
          </button>
        {/if}
      </footer>
    {:else if step === 'import'}
      <div class="wizard-body">
        <h3>Import existing data</h3>
        <p>
          Bringing data from another tracker or an EvolvTrack export? Choose a
          file (CSV, JSON, ODS, or XLSX).
        </p>

        <label
          class="file-picker"
          title={migrationPaused
            ? 'Import is paused until encryption setup finishes. Resume it in Settings first.'
            : undefined}
        >
          <input
            type="file"
            accept=".json,.csv,.tsv,.txt,.ods,.xlsx,application/json,text/csv,application/vnd.oasis.opendocument.spreadsheet,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy || migrationPaused}
            onchange={handleImportFile}
          />
          <span>{busy ? 'Importing…' : 'Choose file'}</span>
        </label>

        {#if migrationPaused}
          <p class="status" role="status">
            Import is paused until encryption setup finishes. You can resume it from Settings.
          </p>
        {/if}
        {#if importStatus}<p class="status" role="status">{importStatus}</p>{/if}
      </div>
      <footer class="wizard-footer">
        <button class="btn btn-ghost" type="button" onclick={skipImport} disabled={busy}>
          Skip
        </button>
        <button class="btn btn-primary" type="button" onclick={() => (step = 'done')} disabled={busy}>
          Done importing
        </button>
      </footer>
    {:else if step === 'medication'}
      <div class="wizard-body">
        <h3>Pick a medication</h3>
        <p>
          {missingMedSummary} imported {totalMissingMed === 1 ? "doesn't" : "don't"} have a medication.
          Pick one to apply to all of them. You can change individual entries later.
        </p>

        <div class="med-options">
          {#each MEDICATIONS as med (med)}
            <label class="med-option">
              <input type="radio" name="medication" value={med} bind:group={pickedMedication} />
              <span>{med}</span>
            </label>
          {/each}
        </div>
      </div>
      <footer class="wizard-footer">
        <button class="btn btn-ghost" type="button" onclick={skipMedicationPick} disabled={busy}>
          Skip
        </button>
        <button
          class="btn btn-primary"
          type="button"
          onclick={applyMedication}
          disabled={busy || !pickedMedication}
        >
          {busy ? 'Applying…' : 'Apply to all'}
        </button>
      </footer>
    {:else if step === 'done'}
      <div class="wizard-body">
        <h3>All set</h3>
        <p>You're ready to start tracking! Anything you skipped is available in Settings.</p>
      </div>
      <footer class="wizard-footer">
        <button class="btn btn-primary" type="button" onclick={finish} disabled={busy}>
          Finish
        </button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .wizard-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: grid;
    place-items: center;
    z-index: 50;
    padding: 1rem;
  }

  .wizard {
    width: min(100%, 560px);
    max-height: calc(100dvh - 2rem);
    overflow-y: auto;
    background: var(--surface, white);
    color: var(--text);
    border-radius: 14px;
    border: 3px solid color-mix(in oklab, var(--text) 18%, transparent);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    display: grid;
    grid-template-rows: auto auto 1fr auto;
  }

  .wizard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.9rem 1.1rem;
    border-bottom: 2px solid color-mix(in oklab, var(--text) 12%, transparent);
  }

  .wizard-header h2 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 800;
  }

  .wizard-note {
    margin: 0;
    padding: 0.55rem 1.1rem;
    font-size: 0.85rem;
    color: var(--muted, #666);
    background: color-mix(in oklab, var(--text) 5%, transparent);
    border-bottom: 1px solid color-mix(in oklab, var(--text) 10%, transparent);
  }

  .close-btn {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 1.6rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.3rem;
  }

  .wizard-body {
    padding: 1.1rem;
    display: grid;
    gap: 0.7rem;
  }

  .wizard-body h3 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 700;
  }

  .wizard-body h4 {
    margin: 0;
    font-size: 0.98rem;
    font-weight: 700;
  }

  .wizard-body p {
    margin: 0;
    line-height: 1.45;
  }

  .hint {
    font-size: 0.88rem;
    color: var(--muted, #666);
  }

  label {
    display: grid;
    gap: 0.3rem;
    font-weight: 600;
    font-size: 0.95rem;
  }

  input[type='password'],
  input[type='text'] {
    padding: 0.65rem;
    border-radius: 10px;
    border: 2px solid color-mix(in oklab, var(--text) 28%, transparent);
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }

  input.mismatch {
    border-color: var(--danger, #b91c1c);
  }

  .field-error {
    font-size: 0.82rem;
    color: var(--danger, #b91c1c);
    font-weight: 500;
  }

  .status {
    font-size: 0.9rem;
    color: var(--muted, #555);
  }

  .status.success {
    color: var(--success, #15803d);
  }

  .file-picker {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    position: relative;
    cursor: pointer;
  }

  .file-picker input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }

  .file-picker span {
    display: inline-flex;
    min-height: 2.6rem;
    align-items: center;
    border-radius: 999px;
    background: color-mix(in oklab, var(--text) 12%, transparent);
    color: var(--text);
    border: 2px solid color-mix(in oklab, var(--text) 22%, transparent);
    font-weight: 700;
    padding: 0.55rem 1.1rem;
  }

  .med-options {
    display: grid;
    gap: 0.3rem;
  }

  .med-option {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-weight: 500;
    cursor: pointer;
  }

  .recovery {
    margin-top: 0.5rem;
    display: grid;
    gap: 0.45rem;
    padding: 0.7rem;
    border-radius: 10px;
    background: color-mix(in oklab, var(--text) 6%, transparent);
  }

  .recovery .code {
    margin: 0;
    padding: 0.55rem 0.7rem;
    background: color-mix(in oklab, var(--text) 5%, transparent);
    border-radius: 6px;
    text-align: center;
    word-break: break-all;
  }

  .recovery .code code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.95rem;
    letter-spacing: 0.06em;
  }

  .copy-btn {
    justify-self: start;
    padding: 0.4rem 0.85rem;
    font-size: 0.85rem;
  }

  .wizard-footer {
    display: flex;
    gap: 0.6rem;
    justify-content: flex-end;
    padding: 0.85rem 1.1rem;
    border-top: 2px solid color-mix(in oklab, var(--text) 12%, transparent);
  }

  .btn {
    appearance: none;
    border-radius: 10px;
    padding: 0.55rem 1.1rem;
    font-weight: 700;
    cursor: pointer;
    font-size: 0.95rem;
    border: 2px solid color-mix(in oklab, var(--text) 22%, transparent);
  }

  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .btn-primary {
    background: var(--brand, #2563eb);
    color: #fff;
    border-color: color-mix(in oklab, var(--brand, #2563eb) 70%, black 30%);
  }

  .btn-ghost {
    background: transparent;
    color: var(--text);
  }
</style>

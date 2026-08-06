import { db } from '$lib/db/schema';
import { get } from 'svelte/store';
import { getProfile, getProfileSyncMode } from '$lib/domain/repo';
import { fetchRemoteSyncAccount } from '$lib/sync/account-state';
import { connectivity } from '$lib/stores/syncStore';
import {
  abandonPreparedTransition,
  isMigrationRunInProgress,
  recoverWithCode,
  resetEncryptionToPlain,
  resumeE2EEDisableMigration,
  resumeE2EEKeyRotation,
  resumeE2EEMigration,
  startFreshToPlain,
  startE2EEDisableMigration,
  startE2EEKeyRotation,
  startE2EEMigration,
  takeOverMigration,
  type E2EEMigrationRunResult,
  type ResetToPlainResult,
} from '$lib/sync/e2ee-migration';
import { deviceEncryptionState } from '$lib/sync/device-encryption-state';
import {
  createE2EELifecycle,
  type E2EELifecycleCommand,
  type E2EELifecyclePort,
  type E2EELifecycleResults,
} from '$lib/sync/e2ee-lifecycle';

type RuntimeE2EELifecycleResults = E2EELifecycleResults & {
  transition: E2EEMigrationRunResult;
  reset: ResetToPlainResult;
  startFresh: void;
  recoveryCode: string;
  recoveryChoice: void;
  takeOver: void;
  abandon: void;
};

async function hasReadableLocalData(): Promise<boolean> {
  const [entries, vials] = await Promise.all([
    db.entries.count(),
    db.prescriptions.count(),
  ]);
  return entries + vials > 0 || deviceEncryptionState.hasReadableLocalTreatmentCiphertext();
}

async function execute(command: E2EELifecycleCommand): Promise<unknown> {
  switch (command.type) {
    case 'start-enable':
      return startE2EEMigration(command.passphrase, { onRecoveryCode: command.onRecoveryCode });
    case 'resume-enable':
      return resumeE2EEMigration(command.passphrase);
    case 'start-disable':
      return startE2EEDisableMigration(command.passphrase);
    case 'resume-disable':
      return resumeE2EEDisableMigration(command.passphrase);
    case 'start-rotate':
      return startE2EEKeyRotation(command.currentPassphrase, command.newPassphrase, {
        onRecoveryCode: command.onRecoveryCode,
      });
    case 'resume-rotate':
      return resumeE2EEKeyRotation(command.currentPassphrase, command.newPassphrase);
    case 'take-over':
      return takeOverMigration();
    case 'reset-to-plain':
      return resetEncryptionToPlain();
    case 'start-fresh':
      return startFreshToPlain();
    case 'recover':
      return recoverWithCode(command.recoveryCode, command.newPassphrase, {
        onRecoveryCode: command.onRecoveryCode,
      });
    case 'generate-recovery':
      return deviceEncryptionState.generateRecoveryCode(command.passphrase);
    case 'acknowledge-recovery':
      return deviceEncryptionState.acknowledgeRecoveryCode();
    case 'continue-without-recovery':
      return deviceEncryptionState.declineRecoveryCode();
    case 'abandon-prepared':
      return abandonPreparedTransition();
  }
}

const runtimePort: E2EELifecyclePort = {
  async read() {
    const [profile, device, remote] = await Promise.all([
      getProfile(),
      deviceEncryptionState.snapshot({ refreshRemote: true }),
      fetchRemoteSyncAccount().catch(() => null),
    ]);
    return {
      syncMode: remote?.syncMode ?? getProfileSyncMode(profile),
      migration: remote?.migration ?? profile?.e2eeMigration,
      deviceId: device.deviceId,
      hasSessionKey: device.hasSessionKey,
      hasReadableLocalData: await hasReadableLocalData(),
      runInProgress: isMigrationRunInProgress(),
      recoveryStatus: device.recoveryStatus,
      connectivity: get(connectivity),
    };
  },
  execute,
};

export const e2eeLifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(runtimePort);

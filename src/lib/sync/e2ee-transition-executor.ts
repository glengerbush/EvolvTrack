import type {
  E2EELifecycleCommand,
  E2EELifecycleFacts,
  E2EELifecyclePort,
  E2EELifecycleResults,
} from '$lib/sync/e2ee-lifecycle';
import { db } from '$lib/db/schema';
import { get } from 'svelte/store';
import { fetchRemoteSyncAccount } from '$lib/sync/account-state';
import { connectivity } from '$lib/stores/syncStore';
import {
  abandonPreparedTransition,
  autoResumeMigration,
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
  type AutoResumeResult,
  type E2EEMigrationRunResult,
  type ResetToPlainResult,
} from '$lib/sync/e2ee-migration';
import { deviceEncryptionState } from '$lib/sync/device-encryption-state';

export type E2EETransitionResult = E2EEMigrationRunResult;
export type RuntimeE2EELifecycleResults = E2EELifecycleResults & {
  transition: E2EEMigrationRunResult;
  reset: ResetToPlainResult;
  startFresh: void;
  recoveryCode: string;
  recoveryChoice: void;
  takeOver: void;
  abandon: void;
  reconcile: AutoResumeResult;
};

export type E2EETransitionOperations = {
  [K in E2EELifecycleCommand['type']]: (
    command: Extract<E2EELifecycleCommand, { type: K }>,
  ) => Promise<unknown>;
};

export type E2EETransitionExecutorDependencies = {
  readFacts(): Promise<E2EELifecycleFacts>;
  operations: E2EETransitionOperations;
};

export function createE2EETransitionExecutor(
  dependencies: E2EETransitionExecutorDependencies,
): E2EELifecyclePort {
  return {
    read: dependencies.readFacts,
    execute(command) {
      const operation = dependencies.operations[command.type] as (
        input: E2EELifecycleCommand,
      ) => Promise<unknown>;
      return operation(command);
    },
  };
}

async function hasReadableLocalData(): Promise<boolean> {
  const [entries, vials] = await Promise.all([
    db.entries.count(),
    db.prescriptions.count(),
  ]);
  return entries + vials > 0 || deviceEncryptionState.hasReadableLocalTreatmentCiphertext();
}

async function readProductionFacts(): Promise<E2EELifecycleFacts> {
  const [device, remote] = await Promise.all([
    deviceEncryptionState.snapshot({ refreshRemote: true }),
    fetchRemoteSyncAccount().catch(() => null),
  ]);
  return {
    syncMode: remote?.syncMode ?? device.syncMode,
    migration: remote?.migration ?? device.migration,
    deviceId: device.deviceId,
    hasSessionKey: device.hasSessionKey,
    hasReadableLocalData: await hasReadableLocalData(),
    runInProgress: isMigrationRunInProgress(),
    recoveryStatus: device.recoveryStatus,
    connectivity: get(connectivity),
  };
}

export const productionE2EETransitionOperations: E2EETransitionOperations = {
  'start-enable': (command) => startE2EEMigration(command.passphrase, {
    onRecoveryCode: command.onRecoveryCode,
  }),
  'resume-enable': (command) => resumeE2EEMigration(command.passphrase),
  'start-disable': (command) => startE2EEDisableMigration(command.passphrase),
  'resume-disable': (command) => resumeE2EEDisableMigration(command.passphrase),
  'start-rotate': (command) => startE2EEKeyRotation(
    command.currentPassphrase,
    command.newPassphrase,
    { onRecoveryCode: command.onRecoveryCode },
  ),
  'resume-rotate': (command) => resumeE2EEKeyRotation(
    command.currentPassphrase,
    command.newPassphrase,
  ),
  'take-over': takeOverMigration,
  'reset-to-plain': resetEncryptionToPlain,
  'start-fresh': startFreshToPlain,
  recover: (command) => recoverWithCode(command.recoveryCode, command.newPassphrase, {
    onRecoveryCode: command.onRecoveryCode,
  }),
  'generate-recovery': (command) => deviceEncryptionState.generateRecoveryCode(command.passphrase),
  'acknowledge-recovery': deviceEncryptionState.acknowledgeRecoveryCode,
  'continue-without-recovery': deviceEncryptionState.declineRecoveryCode,
  'abandon-prepared': abandonPreparedTransition,
  reconcile: autoResumeMigration,
};

export const productionE2EETransitionExecutor = createE2EETransitionExecutor({
  readFacts: readProductionFacts,
  operations: productionE2EETransitionOperations,
});

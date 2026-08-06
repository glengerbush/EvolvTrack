import type { E2EEMigrationState, RecoveryCodeStatus, SyncMode } from '$lib/domain/types';

export type E2EELifecycleFacts = {
  syncMode: SyncMode;
  migration?: E2EEMigrationState;
  deviceId: string;
  hasSessionKey: boolean;
  hasReadableLocalData: boolean;
  runInProgress: boolean;
  recoveryStatus?: RecoveryCodeStatus | 'unavailable';
  connectivity?: 'online' | 'offline' | 'connecting';
};

export type E2EELifecycleCommand =
  | { type: 'start-enable'; passphrase: string; onRecoveryCode?: (code: string) => void }
  | { type: 'resume-enable'; passphrase: string }
  | { type: 'start-disable'; passphrase: string }
  | { type: 'resume-disable'; passphrase: string }
  | { type: 'start-rotate'; currentPassphrase: string; newPassphrase?: string; onRecoveryCode?: (code: string) => void }
  | { type: 'resume-rotate'; currentPassphrase: string; newPassphrase?: string }
  | { type: 'take-over' }
  | { type: 'reset-to-plain' }
  | { type: 'start-fresh' }
  | { type: 'recover'; recoveryCode: string; newPassphrase: string; onRecoveryCode?: (code: string) => void }
  | { type: 'generate-recovery'; passphrase?: string }
  | { type: 'acknowledge-recovery' }
  | { type: 'continue-without-recovery' }
  | { type: 'abandon-prepared' };

export type E2EELifecycleAction =
  | 'enable'
  | 'disable'
  | 'rotate'
  | 'resume'
  | 'take-over'
  | 'generate-recovery'
  | 'acknowledge-recovery'
  | 'continue-without-recovery'
  | 'reset-to-plain'
  | 'start-fresh'
  | 'abandon-prepared';

export type E2EELifecycleSnapshot = {
  status:
    | 'stable-plain'
    | 'stable-e2ee'
    | 'running'
    | 'needs-credentials'
    | 'awaiting-takeover';
  syncMode: SyncMode;
  direction?: E2EEMigrationState['direction'];
  recordsConverted?: number;
  recordsTotal?: number;
  transitionUpdatedAt?: string;
  recoveryStatus?: RecoveryCodeStatus | 'unavailable';
  recoveryAttention: boolean;
  hasReadableLocalData: boolean;
  ownership: 'none' | 'self' | 'other';
  requiredInput: 'none' | 'passphrase' | 'recovery-code';
  errorClassification?: 'network' | 'credentials' | 'integrity' | 'ownership' | 'unknown';
  error?: string;
  connectivity: 'online' | 'offline' | 'connecting';
  allowedActions: E2EELifecycleAction[];
};

export const MIGRATION_OWNER_STALE_MS = 25_000;

export type E2EELifecyclePort = {
  read(): Promise<E2EELifecycleFacts>;
  execute(command: E2EELifecycleCommand): Promise<unknown>;
};

export type E2EELifecycleResults = {
  transition: unknown;
  reset: unknown;
  startFresh: unknown;
  recoveryCode: unknown;
  recoveryChoice: unknown;
  takeOver: unknown;
  abandon: unknown;
};

export type E2EELifecycle<R extends E2EELifecycleResults = E2EELifecycleResults> = {
  enable(passphrase: string, onRecoveryCode?: (code: string) => void): Promise<R['transition']>;
  disable(passphrase: string): Promise<R['transition']>;
  rotate(
    currentPassphrase: string,
    newPassphrase?: string,
    onRecoveryCode?: (code: string) => void,
  ): Promise<R['transition']>;
  resume(passphrase: string, newPassphrase?: string): Promise<R['transition']>;
  takeOver(): Promise<R['takeOver']>;
  resetToPlain(): Promise<R['reset']>;
  startFresh(confirmedNoOtherRecoverableCopy: boolean): Promise<R['startFresh']>;
  recover(
    recoveryCode: string,
    newPassphrase: string,
    onRecoveryCode?: (code: string) => void,
  ): Promise<R['transition']>;
  generateRecoveryCode(passphrase?: string): Promise<R['recoveryCode']>;
  acknowledgeRecoveryCode(): Promise<R['recoveryChoice']>;
  continueWithoutRecoveryCode(): Promise<R['recoveryChoice']>;
  abandonPrepared(): Promise<R['abandon']>;
  refresh(): Promise<E2EELifecycleSnapshot>;
  getSnapshot(): E2EELifecycleSnapshot;
  subscribe(run: (snapshot: E2EELifecycleSnapshot) => void): () => void;
};

type E2EELifecycleOptions = { now?: () => number };

function directionFor(facts: E2EELifecycleFacts): E2EEMigrationState['direction'] {
  return facts.migration?.direction
    ?? (facts.syncMode === 'migrating_to_plain'
      ? 'disable'
      : facts.syncMode === 'rotating_e2ee_key'
        ? 'rotate'
        : 'enable');
}

function snapshotFor(facts: E2EELifecycleFacts, now: number): E2EELifecycleSnapshot {
  const connectivity = facts.connectivity ?? 'online';
  const error = facts.migration?.lastError;
  const errorClassification = !error
    ? undefined
    : /network|fetch|offline|timeout|reach/i.test(error)
      ? 'network' as const
      : /passphrase|recovery code|unlock|credential/i.test(error)
        ? 'credentials' as const
        : /decrypt|integrity|invalid|malformed|mismatch/i.test(error)
          ? 'integrity' as const
          : /owner|supersed|conflict/i.test(error)
            ? 'ownership' as const
            : 'unknown' as const;
  if (facts.syncMode === 'plain') {
    return {
      status: 'stable-plain',
      syncMode: facts.syncMode,
      recoveryAttention: false,
      hasReadableLocalData: facts.hasReadableLocalData,
      ownership: 'none',
      requiredInput: 'none',
      connectivity,
      allowedActions: ['enable'],
    };
  }
  if (facts.syncMode === 'e2ee') {
    const recoveryStatus = facts.recoveryStatus ?? 'unavailable';
    const recoveryAttention = recoveryStatus === 'missing' || recoveryStatus === 'unconfirmed';
    const recoveryActions: E2EELifecycleAction[] = ['generate-recovery'];
    if (recoveryStatus === 'unconfirmed') recoveryActions.push('acknowledge-recovery');
    if (recoveryAttention) recoveryActions.push('continue-without-recovery');
    return {
      status: facts.hasSessionKey ? 'stable-e2ee' : 'needs-credentials',
      syncMode: facts.syncMode,
      recoveryStatus,
      recoveryAttention,
      hasReadableLocalData: facts.hasReadableLocalData,
      ownership: 'none',
      requiredInput: facts.hasSessionKey ? 'none' : 'passphrase',
      connectivity,
      allowedActions: ['disable', 'rotate', ...recoveryActions],
    };
  }

  const direction = directionFor(facts);
  const migration = facts.migration;
  if (migration && migration.ownerDeviceId !== facts.deviceId) {
    const age = now - Date.parse(migration.updatedAt);
    return {
      status: 'awaiting-takeover',
      syncMode: facts.syncMode,
      direction,
      recordsConverted: migration.recordsConverted,
      recordsTotal: migration.recordsTotal,
      transitionUpdatedAt: migration.updatedAt,
      recoveryAttention: false,
      hasReadableLocalData: facts.hasReadableLocalData,
      ownership: 'other',
      requiredInput: 'none',
      errorClassification,
      error,
      connectivity,
      allowedActions: age >= MIGRATION_OWNER_STALE_MS ? ['take-over'] : [],
    };
  }

  if (migration?.phase === 'preparing') {
    return {
      status: 'needs-credentials',
      syncMode: facts.syncMode,
      direction,
      recordsConverted: migration.recordsConverted,
      recordsTotal: migration.recordsTotal,
      transitionUpdatedAt: migration.updatedAt,
      recoveryAttention: false,
      hasReadableLocalData: facts.hasReadableLocalData,
      ownership: 'self',
      requiredInput: 'passphrase',
      errorClassification,
      error,
      connectivity,
      allowedActions: ['resume', 'abandon-prepared'],
    };
  }

  if (!facts.runInProgress && (!facts.hasSessionKey || direction === 'rotate')) {
    return {
      status: 'needs-credentials',
      syncMode: facts.syncMode,
      direction,
      recordsConverted: migration?.recordsConverted,
      recordsTotal: migration?.recordsTotal,
      transitionUpdatedAt: migration?.updatedAt,
      recoveryAttention: false,
      hasReadableLocalData: facts.hasReadableLocalData,
      ownership: 'self',
      requiredInput: 'passphrase',
      errorClassification,
      error,
      connectivity,
      allowedActions: [
        'resume',
        facts.hasReadableLocalData ? 'reset-to-plain' : 'start-fresh',
      ],
    };
  }

  return {
    status: 'running',
    syncMode: facts.syncMode,
    direction,
    recordsConverted: migration?.recordsConverted,
    recordsTotal: migration?.recordsTotal,
    transitionUpdatedAt: migration?.updatedAt,
    recoveryAttention: false,
    hasReadableLocalData: facts.hasReadableLocalData,
    ownership: 'self',
    requiredInput: 'none',
    errorClassification,
    error,
    connectivity,
    allowedActions: [],
  };
}

export function createE2EELifecycle<R extends E2EELifecycleResults = E2EELifecycleResults>(
  port: E2EELifecyclePort,
  options: E2EELifecycleOptions = {},
): E2EELifecycle<R> {
  const now = options.now ?? Date.now;
  let snapshot: E2EELifecycleSnapshot = {
    status: 'stable-plain',
    syncMode: 'plain',
    recoveryAttention: false,
    hasReadableLocalData: false,
    ownership: 'none',
    requiredInput: 'none',
    connectivity: 'online',
    allowedActions: ['enable'],
  };
  const subscribers = new Set<(value: E2EELifecycleSnapshot) => void>();

  async function refreshSnapshot(): Promise<E2EELifecycleSnapshot> {
    snapshot = snapshotFor(await port.read(), now());
    for (const subscriber of subscribers) subscriber(snapshot);
    return snapshot;
  }

  async function execute(command: E2EELifecycleCommand): Promise<unknown> {
    try {
      return await port.execute(command);
    } finally {
      await refreshSnapshot();
    }
  }

  async function factsForOwnedTransition(): Promise<E2EELifecycleFacts> {
    const facts = await port.read();
    if (!facts.migration || facts.migration.ownerDeviceId !== facts.deviceId) {
      throw new Error('This device does not own the active Encryption Transition.');
    }
    return facts;
  }

  return {
    async enable(passphrase, onRecoveryCode) {
      const facts = await port.read();
      if (facts.syncMode === 'plain') {
        return execute({
          type: 'start-enable',
          passphrase,
          ...(onRecoveryCode ? { onRecoveryCode } : {}),
        });
      }
      if (
        facts.syncMode === 'migrating_to_e2ee'
        && facts.migration?.direction === 'enable'
        && facts.migration.ownerDeviceId === facts.deviceId
      ) {
        return execute({ type: 'resume-enable', passphrase });
      }
      throw new Error('Encryption cannot be enabled from the current lifecycle state.');
    },
    async disable(passphrase) {
      const facts = await port.read();
      if (facts.syncMode === 'e2ee') {
        return execute({ type: 'start-disable', passphrase });
      }
      if (
        facts.syncMode === 'migrating_to_plain'
        && facts.migration?.ownerDeviceId === facts.deviceId
      ) {
        return execute({ type: 'resume-disable', passphrase });
      }
      throw new Error('Encryption cannot be disabled from the current lifecycle state.');
    },
    async rotate(currentPassphrase, newPassphrase, onRecoveryCode) {
      const facts = await port.read();
      if (facts.syncMode === 'e2ee') {
        return execute({
          type: 'start-rotate',
          currentPassphrase,
          newPassphrase,
          ...(onRecoveryCode ? { onRecoveryCode } : {}),
        });
      }
      if (
        facts.syncMode === 'rotating_e2ee_key'
        && facts.migration?.ownerDeviceId === facts.deviceId
      ) {
        return execute({ type: 'resume-rotate', currentPassphrase, newPassphrase });
      }
      throw new Error('The encryption key cannot be rotated from the current lifecycle state.');
    },
    async resume(passphrase, newPassphrase) {
      const facts = await factsForOwnedTransition();
      const direction = directionFor(facts);
      if (direction === 'disable') {
        return execute({ type: 'resume-disable', passphrase });
      }
      if (direction === 'rotate') {
        return execute({
          type: 'resume-rotate',
          currentPassphrase: passphrase,
          newPassphrase,
        });
      }
      return execute({ type: 'resume-enable', passphrase });
    },
    async takeOver() {
      const facts = await port.read();
      if (!facts.migration || facts.migration.ownerDeviceId === facts.deviceId) {
        throw new Error('No foreign Encryption Transition is available to take over.');
      }
      const age = now() - Date.parse(facts.migration.updatedAt);
      if (age < MIGRATION_OWNER_STALE_MS) {
        throw new Error('The active Encryption Transition is not stale yet.');
      }
      return execute({ type: 'take-over' });
    },
    async startFresh(confirmedNoOtherRecoverableCopy) {
      if (!confirmedNoOtherRecoverableCopy) {
        throw new Error('Confirm that no other device or backup has a Recoverable Copy.');
      }
      const facts = await port.read();
      if (facts.hasReadableLocalData) {
        throw new Error('Start Fresh is unavailable while this device has readable treatment data.');
      }
      return execute({ type: 'start-fresh' });
    },
    async resetToPlain() {
      const facts = await port.read();
      if (!facts.hasReadableLocalData) {
        throw new Error('There is no readable treatment data on this device to keep.');
      }
      return execute({ type: 'reset-to-plain' });
    },
    async recover(recoveryCode, newPassphrase, onRecoveryCode) {
      return execute({
        type: 'recover',
        recoveryCode,
        newPassphrase,
        ...(onRecoveryCode ? { onRecoveryCode } : {}),
      });
    },
    async generateRecoveryCode(passphrase) {
      return execute({ type: 'generate-recovery', passphrase });
    },
    async acknowledgeRecoveryCode() {
      return execute({ type: 'acknowledge-recovery' });
    },
    async continueWithoutRecoveryCode() {
      return execute({ type: 'continue-without-recovery' });
    },
    async abandonPrepared() {
      const facts = await factsForOwnedTransition();
      if (facts.migration?.phase !== 'preparing') {
        throw new Error('This Encryption Transition has already changed cloud data.');
      }
      return execute({ type: 'abandon-prepared' });
    },
    async refresh() {
      return refreshSnapshot();
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(run) {
      subscribers.add(run);
      run(snapshot);
      return () => subscribers.delete(run);
    },
  } as E2EELifecycle<R>;
}

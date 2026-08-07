import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2EEMigrationState } from '$lib/domain/types';
import { createE2EELifecycle, type E2EELifecycleFacts } from './e2ee-lifecycle';

vi.mock('./e2ee-migration', () => ({
  abandonPreparedTransition: vi.fn(async () => undefined),
  autoResumeMigration: vi.fn(async () => ({ status: 'idle' })),
  isMigrationRunInProgress: vi.fn(() => false),
  recoverWithCode: vi.fn(async () => undefined),
  resetEncryptionToPlain: vi.fn(async () => undefined),
  resumeE2EEDisableMigration: vi.fn(async () => undefined),
  resumeE2EEKeyRotation: vi.fn(async () => undefined),
  resumeE2EEMigration: vi.fn(async () => undefined),
  startFreshToPlain: vi.fn(async () => undefined),
  startE2EEDisableMigration: vi.fn(async () => undefined),
  startE2EEKeyRotation: vi.fn(async () => undefined),
  startE2EEMigration: vi.fn(async () => undefined),
  takeOverMigration: vi.fn(async () => undefined),
}));

vi.mock('./device-encryption-state', () => ({
  deviceEncryptionState: {
    acknowledgeRecoveryCode: vi.fn(async () => undefined),
    declineRecoveryCode: vi.fn(async () => undefined),
    generateRecoveryCode: vi.fn(async () => 'recovery-code'),
  },
}));

import {
  abandonPreparedTransition,
  autoResumeMigration,
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
} from './e2ee-migration';
import { deviceEncryptionState } from './device-encryption-state';
import {
  createE2EETransitionExecutor,
  productionE2EETransitionOperations,
} from './e2ee-transition-executor';

const transition: E2EEMigrationState = {
  id: 'transition-1',
  direction: 'enable',
  ownerDeviceId: 'device-1',
  phase: 'preparing',
  startedAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:01.000Z',
};

function lifecycleFor(facts: E2EELifecycleFacts, now?: () => number) {
  let reads = 0;
  const lifecycle = createE2EELifecycle(createE2EETransitionExecutor({
    readFacts: async () => {
      reads += 1;
      return facts;
    },
    operations: productionE2EETransitionOperations,
  }), now ? { now } : undefined);
  return { lifecycle, reads: () => reads };
}

describe('production Encryption Transition composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exhaustively wires start and resume commands to production transition operations', async () => {
    const plain = lifecycleFor({
      syncMode: 'plain', deviceId: 'device-1', hasSessionKey: false,
      hasReadableLocalData: false, runInProgress: false,
    });
    await plain.lifecycle.enable('passphrase');
    expect(startE2EEMigration).toHaveBeenCalledWith('passphrase', { onRecoveryCode: undefined });

    const e2ee = lifecycleFor({
      syncMode: 'e2ee', deviceId: 'device-1', hasSessionKey: true,
      hasReadableLocalData: true, runInProgress: false,
    });
    await e2ee.lifecycle.disable('passphrase');
    await e2ee.lifecycle.rotate('old-passphrase', 'new-passphrase');
    expect(startE2EEDisableMigration).toHaveBeenCalledWith('passphrase');
    expect(startE2EEKeyRotation).toHaveBeenCalledWith(
      'old-passphrase', 'new-passphrase', { onRecoveryCode: undefined },
    );

    for (const [direction, syncMode, operation] of [
      ['enable', 'migrating_to_e2ee', resumeE2EEMigration],
      ['disable', 'migrating_to_plain', resumeE2EEDisableMigration],
      ['rotate', 'rotating_e2ee_key', resumeE2EEKeyRotation],
    ] as const) {
      const interrupted = lifecycleFor({
        syncMode,
        migration: { ...transition, direction },
        deviceId: 'device-1',
        hasSessionKey: false,
        hasReadableLocalData: true,
        runInProgress: false,
      });
      await interrupted.lifecycle.resume('passphrase', 'new-passphrase');
      expect(operation).toHaveBeenCalled();
      expect(interrupted.reads()).toBe(2);
    }
    expect(resumeE2EEMigration).toHaveBeenCalledWith('passphrase');
    expect(resumeE2EEDisableMigration).toHaveBeenCalledWith('passphrase');
    expect(resumeE2EEKeyRotation).toHaveBeenCalledWith('passphrase', 'new-passphrase');
  });

  it('exhaustively wires recovery, ownership, destructive, and reconciliation commands', async () => {
    const stable = lifecycleFor({
      syncMode: 'e2ee', deviceId: 'device-1', hasSessionKey: true,
      hasReadableLocalData: true, runInProgress: false,
    });
    await stable.lifecycle.recover('recovery-code', 'new-passphrase');
    await stable.lifecycle.generateRecoveryCode('passphrase');
    await stable.lifecycle.acknowledgeRecoveryCode();
    await stable.lifecycle.continueWithoutRecoveryCode();
    await stable.lifecycle.reconcile();
    expect(recoverWithCode).toHaveBeenCalledWith(
      'recovery-code', 'new-passphrase', { onRecoveryCode: undefined },
    );
    expect(deviceEncryptionState.generateRecoveryCode).toHaveBeenCalledWith('passphrase');
    expect(deviceEncryptionState.acknowledgeRecoveryCode).toHaveBeenCalled();
    expect(deviceEncryptionState.declineRecoveryCode).toHaveBeenCalled();
    expect(autoResumeMigration).toHaveBeenCalled();

    const owned = lifecycleFor({
      syncMode: 'migrating_to_e2ee', migration: transition, deviceId: 'device-1',
      hasSessionKey: false, hasReadableLocalData: true, runInProgress: false,
    });
    await owned.lifecycle.resetToPlain();
    await owned.lifecycle.abandonPrepared();
    expect(resetEncryptionToPlain).toHaveBeenCalled();
    expect(abandonPreparedTransition).toHaveBeenCalled();

    const empty = lifecycleFor({
      syncMode: 'migrating_to_plain', migration: { ...transition, direction: 'disable' },
      deviceId: 'device-1', hasSessionKey: false, hasReadableLocalData: false,
      runInProgress: false,
    });
    await empty.lifecycle.startFresh(true);
    expect(startFreshToPlain).toHaveBeenCalled();

    const foreign = lifecycleFor({
      syncMode: 'migrating_to_e2ee',
      migration: { ...transition, ownerDeviceId: 'other-device' },
      deviceId: 'device-1', hasSessionKey: false, hasReadableLocalData: false,
      runInProgress: false,
    }, () => Date.parse('2026-08-06T00:00:27.000Z'));
    await foreign.lifecycle.takeOver();
    expect(takeOverMigration).toHaveBeenCalled();

    expect(Object.keys(productionE2EETransitionOperations).sort()).toEqual([
      'abandon-prepared', 'acknowledge-recovery', 'continue-without-recovery',
      'generate-recovery', 'reconcile', 'recover', 'reset-to-plain',
      'resume-disable', 'resume-enable', 'resume-rotate', 'start-disable',
      'start-enable', 'start-fresh', 'start-rotate', 'take-over',
    ]);
  });
});

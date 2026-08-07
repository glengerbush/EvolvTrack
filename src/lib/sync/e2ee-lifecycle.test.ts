import { describe, expect, it } from 'vitest';
import type { E2EEMigrationState } from '$lib/domain/types';
import {
  createE2EELifecycle,
  type E2EELifecycleCommand,
  type E2EELifecycleFacts,
  type E2EELifecyclePort,
} from './e2ee-lifecycle';

const migration: E2EEMigrationState = {
  id: 'migration-1',
  direction: 'enable',
  ownerDeviceId: 'device-1',
  startedAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:01.000Z',
};

function makeLifecycle(initial: E2EELifecycleFacts) {
  let facts = initial;
  const commands: E2EELifecycleCommand[] = [];
  const port: E2EELifecyclePort = {
    read: async () => facts,
    execute: async (command) => {
      commands.push(command);
      facts = {
        ...facts,
        syncMode: command.type === 'start-enable' || command.type === 'resume-enable'
          ? 'e2ee'
          : facts.syncMode,
        migration: undefined,
        runInProgress: false,
      };
      return { completed: true };
    },
  };
  return { lifecycle: createE2EELifecycle(port), commands };
}

describe('E2EE lifecycle', () => {
  it('turns the same enable intent into start or resume from durable state', async () => {
    const plain = makeLifecycle({
      syncMode: 'plain',
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
    });
    await plain.lifecycle.enable('passphrase');
    expect(plain.commands).toEqual([{ type: 'start-enable', passphrase: 'passphrase' }]);

    const interrupted = makeLifecycle({
      syncMode: 'migrating_to_e2ee',
      migration,
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
    });
    await interrupted.lifecycle.enable('passphrase');
    expect(interrupted.commands).toEqual([{ type: 'resume-enable', passphrase: 'passphrase' }]);
  });

  it('publishes takeover only after the foreign owner is stale', async () => {
    const foreign = makeLifecycle({
      syncMode: 'migrating_to_e2ee',
      migration: { ...migration, ownerDeviceId: 'other-device' },
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
    });
    const lifecycle = createE2EELifecycle(
      {
        read: async () => ({
          syncMode: 'migrating_to_e2ee',
          migration: { ...migration, ownerDeviceId: 'other-device' },
          deviceId: 'device-1',
          hasSessionKey: false,
          hasReadableLocalData: false,
          runInProgress: false,
        }),
        execute: async () => undefined,
      },
      { now: () => Date.parse('2026-08-06T00:00:27.000Z') },
    );

    await lifecycle.refresh();

    expect(lifecycle.getSnapshot()).toMatchObject({
      status: 'awaiting-takeover',
      direction: 'enable',
      allowedActions: ['take-over'],
    });
    expect(foreign.commands).toEqual([]);
  });

  it('resumes the durable direction without asking the caller to branch', async () => {
    const interrupted = makeLifecycle({
      syncMode: 'migrating_to_plain',
      migration: { ...migration, direction: 'disable' },
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
    });

    await interrupted.lifecycle.resume('passphrase');

    expect(interrupted.commands).toEqual([{ type: 'resume-disable', passphrase: 'passphrase' }]);
  });

  it('refuses Start Fresh while this device has readable treatment data', async () => {
    const withData = makeLifecycle({
      syncMode: 'migrating_to_plain',
      migration: { ...migration, direction: 'disable' },
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: true,
      runInProgress: false,
    });

    await expect(withData.lifecycle.startFresh(true)).rejects.toThrow(/readable treatment data/i);
    expect(withData.commands).toEqual([]);
  });

  it('keeps E2EE stable while exposing unconfirmed recovery-code actions', async () => {
    const stable = makeLifecycle({
      syncMode: 'e2ee',
      deviceId: 'device-1',
      hasSessionKey: true,
      hasReadableLocalData: true,
      runInProgress: false,
      recoveryStatus: 'unconfirmed',
    });

    await stable.lifecycle.refresh();

    expect(stable.lifecycle.getSnapshot()).toMatchObject({
      status: 'stable-e2ee',
      recoveryStatus: 'unconfirmed',
      recoveryAttention: true,
      allowedActions: expect.arrayContaining(['generate-recovery', 'continue-without-recovery']),
    });
  });

  it('publishes stable-state unlock as required lifecycle input', async () => {
    const locked = makeLifecycle({
      syncMode: 'e2ee',
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
      recoveryStatus: 'confirmed',
    });

    await locked.lifecycle.refresh();

    expect(locked.lifecycle.getSnapshot()).toMatchObject({
      status: 'needs-credentials',
      requiredInput: 'passphrase',
      syncMode: 'e2ee',
    });
  });

  it('records explicit recovery-code choices without changing E2EE mode', async () => {
    const stable = makeLifecycle({
      syncMode: 'e2ee',
      deviceId: 'device-1',
      hasSessionKey: true,
      hasReadableLocalData: true,
      runInProgress: false,
      recoveryStatus: 'unconfirmed',
    });

    await stable.lifecycle.acknowledgeRecoveryCode();
    await stable.lifecycle.continueWithoutRecoveryCode();

    expect(stable.commands).toEqual([
      { type: 'acknowledge-recovery' },
      { type: 'continue-without-recovery' },
    ]);
  });

  it('allows abandonment only while the owned transition is prepared', async () => {
    const prepared = makeLifecycle({
      syncMode: 'migrating_to_e2ee',
      migration: { ...migration, phase: 'preparing' },
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
    });
    await prepared.lifecycle.refresh();
    expect(prepared.lifecycle.getSnapshot().allowedActions).toContain('abandon-prepared');
    await prepared.lifecycle.abandonPrepared();
    expect(prepared.commands).toContainEqual({ type: 'abandon-prepared' });

    const transferring = makeLifecycle({
      syncMode: 'migrating_to_e2ee',
      migration: { ...migration, phase: 'transferring' },
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
    });
    await expect(transferring.lifecycle.abandonPrepared()).rejects.toThrow(/already changed cloud data/i);
  });

  it('classifies required input and retryable network state in one snapshot', async () => {
    const interrupted = makeLifecycle({
      syncMode: 'migrating_to_plain',
      migration: {
        ...migration,
        direction: 'disable',
        recordsConverted: 7,
        recordsTotal: 12,
        lastError: 'Network timeout',
      },
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
      connectivity: 'offline',
    });

    await interrupted.lifecycle.refresh();
    expect(interrupted.lifecycle.getSnapshot()).toMatchObject({
      ownership: 'self',
      requiredInput: 'passphrase',
      recordsConverted: 7,
      recordsTotal: 12,
      errorClassification: 'network',
      connectivity: 'offline',
      allowedActions: ['resume', 'start-fresh'],
    });
  });

  it('owns background transition reconciliation', async () => {
    const interrupted = makeLifecycle({
      syncMode: 'migrating_to_e2ee',
      migration,
      deviceId: 'device-1',
      hasSessionKey: true,
      hasReadableLocalData: true,
      runInProgress: false,
    });

    await interrupted.lifecycle.reconcile();

    expect(interrupted.commands).toContainEqual({ type: 'reconcile' });
  });
});

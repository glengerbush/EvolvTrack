import { describe, expect, it, vi } from 'vitest';
import { createE2EELifecycle, type E2EELifecycleFacts } from './e2ee-lifecycle';
import type { E2EEMigrationState } from '$lib/domain/types';
import {
  createE2EETransitionExecutor,
  type E2EETransitionOperations,
} from './e2ee-transition-executor';

function operations(overrides: Partial<E2EETransitionOperations> = {}): E2EETransitionOperations {
  const noOp = vi.fn(async () => undefined);
  return {
    'start-enable': noOp,
    'resume-enable': noOp,
    'start-disable': noOp,
    'resume-disable': noOp,
    'start-rotate': noOp,
    'resume-rotate': noOp,
    'take-over': noOp,
    'reset-to-plain': noOp,
    'start-fresh': noOp,
    recover: noOp,
    'generate-recovery': noOp,
    'acknowledge-recovery': noOp,
    'continue-without-recovery': noOp,
    'abandon-prepared': noOp,
    reconcile: noOp,
    ...overrides,
  } as E2EETransitionOperations;
}

describe('Encryption Transition executor through lifecycle', () => {
  it('executes enable and refreshes lifecycle facts', async () => {
    let reads = 0;
    const facts: E2EELifecycleFacts = {
      syncMode: 'plain',
      deviceId: 'device-1',
      hasSessionKey: false,
      hasReadableLocalData: false,
      runInProgress: false,
    };
    const startEnable = vi.fn(async () => {
      facts.syncMode = 'e2ee';
      facts.hasSessionKey = true;
      return { completed: true };
    });
    const lifecycle = createE2EELifecycle(createE2EETransitionExecutor({
      readFacts: async () => { reads += 1; return facts; },
      operations: operations({ 'start-enable': startEnable }),
    }));

    await expect(lifecycle.enable('passphrase')).resolves.toEqual({ completed: true });

    expect(startEnable).toHaveBeenCalledWith({ type: 'start-enable', passphrase: 'passphrase' });
    expect(reads).toBe(2);
    expect(lifecycle.getSnapshot()).toMatchObject({
      status: 'stable-e2ee',
      syncMode: 'e2ee',
      allowedActions: expect.arrayContaining(['disable', 'rotate']),
    });
  });

  it('routes resume from durable transition direction', async () => {
    const baseMigration: E2EEMigrationState = {
      id: 'migration-1',
      ownerDeviceId: 'device-1',
      startedAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:01.000Z',
    };
    const cases = [
      { direction: 'enable', syncMode: 'migrating_to_e2ee', operation: 'resume-enable' },
      { direction: 'disable', syncMode: 'migrating_to_plain', operation: 'resume-disable' },
      { direction: 'rotate', syncMode: 'rotating_e2ee_key', operation: 'resume-rotate' },
    ] as const;

    for (const scenario of cases) {
      const resume = vi.fn(async () => ({ completed: true }));
      const lifecycle = createE2EELifecycle(createE2EETransitionExecutor({
        readFacts: async () => ({
          syncMode: scenario.syncMode,
          migration: { ...baseMigration, direction: scenario.direction },
          deviceId: 'device-1',
          hasSessionKey: false,
          hasReadableLocalData: true,
          runInProgress: false,
        }),
        operations: operations({ [scenario.operation]: resume }),
      }));

      await lifecycle.resume('passphrase', 'new-passphrase');

      expect(resume).toHaveBeenCalledWith(scenario.direction === 'rotate'
        ? { type: 'resume-rotate', currentPassphrase: 'passphrase', newPassphrase: 'new-passphrase' }
        : { type: scenario.operation, passphrase: 'passphrase' });
    }
  });

  it('routes stable E2EE and Recovery choices without exposing commands', async () => {
    const disable = vi.fn(async () => undefined);
    const rotate = vi.fn(async () => undefined);
    const recover = vi.fn(async () => undefined);
    const generate = vi.fn(async () => 'recovery-code');
    const acknowledge = vi.fn(async () => undefined);
    const decline = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => ({ status: 'idle' }));
    const lifecycle = createE2EELifecycle(createE2EETransitionExecutor({
      readFacts: async () => ({
        syncMode: 'e2ee',
        deviceId: 'device-1',
        hasSessionKey: true,
        hasReadableLocalData: true,
        runInProgress: false,
        recoveryStatus: 'unconfirmed',
      }),
      operations: operations({
        'start-disable': disable,
        'start-rotate': rotate,
        recover,
        'generate-recovery': generate,
        'acknowledge-recovery': acknowledge,
        'continue-without-recovery': decline,
        reconcile,
      }),
    }));

    await lifecycle.disable('passphrase');
    await lifecycle.rotate('old-passphrase', 'new-passphrase');
    await lifecycle.recover('recovery-code', 'new-passphrase');
    await expect(lifecycle.generateRecoveryCode('passphrase')).resolves.toBe('recovery-code');
    await lifecycle.acknowledgeRecoveryCode();
    await lifecycle.continueWithoutRecoveryCode();
    await lifecycle.reconcile();

    expect(disable).toHaveBeenCalledWith({ type: 'start-disable', passphrase: 'passphrase' });
    expect(rotate).toHaveBeenCalledWith({
      type: 'start-rotate', currentPassphrase: 'old-passphrase', newPassphrase: 'new-passphrase',
    });
    expect(recover).toHaveBeenCalledWith({
      type: 'recover', recoveryCode: 'recovery-code', newPassphrase: 'new-passphrase',
    });
    expect(generate).toHaveBeenCalledWith({ type: 'generate-recovery', passphrase: 'passphrase' });
    expect(acknowledge).toHaveBeenCalledWith({ type: 'acknowledge-recovery' });
    expect(decline).toHaveBeenCalledWith({ type: 'continue-without-recovery' });
    expect(reconcile).toHaveBeenCalledWith({ type: 'reconcile' });
  });

  it('routes guarded takeover, reset, Start Fresh, and prepared abandonment', async () => {
    const transition: E2EEMigrationState = {
      id: 'migration-1',
      direction: 'disable',
      phase: 'preparing',
      ownerDeviceId: 'device-1',
      startedAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:01.000Z',
    };
    const reset = vi.fn(async () => undefined);
    const abandon = vi.fn(async () => undefined);
    const owned = createE2EELifecycle(createE2EETransitionExecutor({
      readFacts: async () => ({
        syncMode: 'migrating_to_plain',
        migration: transition,
        deviceId: 'device-1',
        hasSessionKey: false,
        hasReadableLocalData: true,
        runInProgress: false,
      }),
      operations: operations({ 'reset-to-plain': reset, 'abandon-prepared': abandon }),
    }));
    await owned.resetToPlain();
    await owned.abandonPrepared();
    expect(reset).toHaveBeenCalledWith({ type: 'reset-to-plain' });
    expect(abandon).toHaveBeenCalledWith({ type: 'abandon-prepared' });

    const startFresh = vi.fn(async () => undefined);
    const empty = createE2EELifecycle(createE2EETransitionExecutor({
      readFacts: async () => ({
        syncMode: 'migrating_to_plain',
        migration: transition,
        deviceId: 'device-1',
        hasSessionKey: false,
        hasReadableLocalData: false,
        runInProgress: false,
      }),
      operations: operations({ 'start-fresh': startFresh }),
    }));
    await empty.startFresh(true);
    expect(startFresh).toHaveBeenCalledWith({ type: 'start-fresh' });

    const takeOver = vi.fn(async () => undefined);
    const foreign = createE2EELifecycle(createE2EETransitionExecutor({
      readFacts: async () => ({
        syncMode: 'migrating_to_plain',
        migration: { ...transition, ownerDeviceId: 'other-device' },
        deviceId: 'device-1',
        hasSessionKey: false,
        hasReadableLocalData: false,
        runInProgress: false,
      }),
      operations: operations({ 'take-over': takeOver }),
    }), { now: () => Date.parse('2026-08-06T00:00:27.000Z') });
    await foreign.takeOver();
    expect(takeOver).toHaveBeenCalledWith({ type: 'take-over' });
  });
});

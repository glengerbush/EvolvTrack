import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import type {
  E2EEMigrationState,
  ProfileSettings,
  SyncMode,
  WrappedKeyBundle,
} from '$lib/domain/types';

const state = vi.hoisted(() => ({
  mockProfile: undefined as ProfileSettings | undefined,
  saveProfileCalls: [] as Array<Partial<ProfileSettings>>,
  upsertAccountCalls: [] as Array<{ mode: SyncMode; migration?: E2EEMigrationState }>,
  localBundle: undefined as WrappedKeyBundle | undefined,
  remoteBundle: undefined as WrappedKeyBundle | undefined,
  saveLocalBundleCalls: [] as Array<Omit<WrappedKeyBundle, 'id'>>,
  upsertRemoteBundleCalls: [] as WrappedKeyBundle[],
  generatedDekCounter: 0,
  generatedRecoveryCounter: 0,
}));

vi.mock('$lib/domain/repo', () => ({
  getAllWeights: vi.fn(async () => [
    { id: 'w1', date: '2026-05-01', weightLbs: 180, updatedAt: '2026-05-01T00:00:00.000Z' },
  ]),
  getAllInjections: vi.fn(async () => [
    { id: 'i1', date: '2026-05-01', amountMg: 5, medication: 'Sema', updatedAt: '2026-05-01T00:00:00.000Z' },
  ]),
  getAllPrescriptions: vi.fn(async () => []),
  getProfile: vi.fn(async () => state.mockProfile),
  getProfileSyncMode: (p: ProfileSettings | undefined): SyncMode => p?.syncMode ?? 'plain',
  saveProfile: vi.fn(async (partial: Partial<ProfileSettings>) => {
    state.saveProfileCalls.push(partial);
    state.mockProfile = {
      id: 'profile',
      createdAt: state.mockProfile?.createdAt ?? '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-05-09T00:00:00.000Z',
      passphraseEnabled: false,
      syncMode: 'plain',
      ...state.mockProfile,
      ...partial,
    } as ProfileSettings;
  }),
}));

vi.mock('$lib/crypto/e2ee', () => ({
  ENCRYPTION_FORMAT_VERSION: 1,
  generateDek: vi.fn(async () => {
    state.generatedDekCounter += 1;
    return `DEK_${state.generatedDekCounter}`;
  }),
  generateRecoveryCode: vi.fn(() => {
    state.generatedRecoveryCounter += 1;
    return `CODE_${state.generatedRecoveryCounter}`;
  }),
  generateSaltB64: vi.fn(() => 'SALT'),
  derivePassphraseKek: vi.fn(async (passphrase: string) => `KEK(${passphrase})`),
  deriveRecoveryKek: vi.fn(async (code: string) => `RKEK(${code})`),
  wrapDek: vi.fn(async (kek: string, dek: string) => ({
    ciphertext: `wrap(${kek},${dek})`,
    iv: 'wiv',
  })),
  unwrapDek: vi.fn(async (kek: string, ciphertext: string) => {
    const match = ciphertext.match(/^wrap\(([^,]+),(.+)\)$/);
    if (!match || match[1] !== kek) throw new Error('OperationError');
    return match[2];
  }),
  encryptRecord: vi.fn(async (_key: string, record: unknown) => ({
    ciphertext: `ct:${JSON.stringify(record)}`,
    iv: 'iv',
  })),
  decryptRecord: vi.fn(async (_key: string, ciphertext: string) => {
    return JSON.parse(ciphertext.replace(/^ct:/, ''));
  }),
}));

vi.mock('$lib/sync/session-key', () => ({
  setSessionKey: vi.fn(),
  clearSession: vi.fn(),
  getSessionKey: vi.fn(() => null),
}));

vi.mock('$lib/sync/account-state', () => ({
  getDeviceId: vi.fn(() => 'device-1'),
  upsertRemoteSyncAccount: vi.fn(async (mode: SyncMode, migration?: E2EEMigrationState) => {
    state.upsertAccountCalls.push({ mode, migration });
  }),
}));

vi.mock('$lib/sync/wrapped-keys', () => ({
  getLocalWrappedKeys: vi.fn(async () => state.localBundle),
  saveLocalWrappedKeys: vi.fn(async (bundle: Omit<WrappedKeyBundle, 'id'>) => {
    state.saveLocalBundleCalls.push(bundle);
    const row: WrappedKeyBundle = { id: 'self', ...bundle };
    state.localBundle = row;
    return row;
  }),
  clearLocalWrappedKeys: vi.fn(async () => {
    state.localBundle = undefined;
  }),
  fetchRemoteWrappedKeys: vi.fn(async () => state.remoteBundle ?? null),
  upsertRemoteWrappedKeys: vi.fn(async (bundle: WrappedKeyBundle) => {
    state.upsertRemoteBundleCalls.push(bundle);
    state.remoteBundle = bundle;
  }),
  deleteRemoteWrappedKeys: vi.fn(async () => {
    state.remoteBundle = undefined;
  }),
}));

const pushEncryptedChangesMock = vi.fn(async (..._args: unknown[]) => ({ pushed: 0 }));
const deleteRemoteEncryptedChangesMock = vi.fn(async (..._args: unknown[]) => ({ deleted: 0 }));

vi.mock('$lib/sync/sync-engine', () => ({
  pushEncryptedChanges: (...args: unknown[]) => pushEncryptedChangesMock(...args),
  pushPlainChanges: vi.fn(async () => ({ pushed: 0 })),
  deleteRemoteEncryptedChanges: (...args: unknown[]) => deleteRemoteEncryptedChangesMock(...args),
  fetchRemoteEncryptedChanges: vi.fn(async () => []),
}));

import {
  resumeE2EEKeyRotation,
  startE2EEKeyRotation,
} from './e2ee-migration';
import { db } from '$lib/db/schema';
import { setSessionKey, getSessionKey } from '$lib/sync/session-key';
import { encryptRecord, generateDek, generateRecoveryCode } from '$lib/crypto/e2ee';
import { clearPullCursor, getPullCursor, setPullCursor } from '$lib/sync/pull-cursor';

function bundleWrappedFor(
  passphrase: string,
  dekToken: string,
  dekVersion = 1,
): WrappedKeyBundle {
  return {
    id: 'self',
    dekVersion,
    passphraseSaltB64: 'SALT',
    passphraseWrapped: {
      ciphertext: `wrap(KEK(${passphrase}),${dekToken})`,
      iv: 'wiv',
    },
    recoverySaltB64: 'SALT',
    recoveryWrapped: { ciphertext: `wrap(RKEK(OLD_CODE),${dekToken})`, iv: 'wiv' },
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  state.mockProfile = undefined;
  state.saveProfileCalls.length = 0;
  state.upsertAccountCalls.length = 0;
  state.localBundle = undefined;
  state.remoteBundle = undefined;
  state.saveLocalBundleCalls.length = 0;
  state.upsertRemoteBundleCalls.length = 0;
  state.generatedDekCounter = 0;
  state.generatedRecoveryCounter = 0;
  pushEncryptedChangesMock.mockClear();
  pushEncryptedChangesMock.mockResolvedValue({ pushed: 0 });
  deleteRemoteEncryptedChangesMock.mockClear();
  deleteRemoteEncryptedChangesMock.mockResolvedValue({ deleted: 0 });
  vi.mocked(encryptRecord).mockClear();
  vi.mocked(generateDek).mockClear();
  vi.mocked(generateRecoveryCode).mockClear();
  vi.mocked(setSessionKey).mockClear();
  vi.mocked(getSessionKey).mockReturnValue(null);
  clearPullCursor();
});

describe('startE2EEKeyRotation — argument validation', () => {
  it('requires a current passphrase', async () => {
    await expect(startE2EEKeyRotation('')).rejects.toThrow(/current passphrase is required/i);
  });

  it('rejects when E2EE is not enabled', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await expect(startE2EEKeyRotation('pw')).rejects.toThrow(/requires E2EE/i);
  });

  it('rejects when an enable/disable migration is mid-flight', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'migrating_to_e2ee' } as ProfileSettings;
    await expect(startE2EEKeyRotation('pw')).rejects.toThrow(/requires E2EE/i);
  });
});

describe('startE2EEKeyRotation — change-passphrase happy path', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundleWrappedFor('OLD_PW', 'OLD_DEK', 3);
    state.remoteBundle = state.localBundle;
  });

  it('mints a new DEK + recovery code and wraps the new DEK under the new passphrase', async () => {
    const result = await startE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(generateDek).toHaveBeenCalledTimes(1);
    expect(generateRecoveryCode).toHaveBeenCalledTimes(1);
    expect(result.recoveryCode).toBe('CODE_1');
    expect(result.completed).toBe(true);

    // New bundle was saved with the new passphrase wrap and a bumped dekVersion.
    expect(state.localBundle?.dekVersion).toBe(4);
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(NEW_PW),DEK_1)');
    expect(state.remoteBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(NEW_PW),DEK_1)');
  });

  it('caches the new DEK as the session key', async () => {
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    expect(setSessionKey).toHaveBeenCalledWith('DEK_1');
  });

  it('re-encrypts every record under the new DEK', async () => {
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    // 1 weight + 1 injection + 1 profile = 3.
    expect(vi.mocked(encryptRecord).mock.calls.length).toBe(3);
    for (const call of vi.mocked(encryptRecord).mock.calls) {
      expect(call[0]).toBe('DEK_1');
    }
  });

  it('deletes old encrypted server rows before pushing new ones (forward secrecy)', async () => {
    const order: string[] = [];
    deleteRemoteEncryptedChangesMock.mockImplementationOnce(async () => {
      order.push('delete');
      return { deleted: 5 };
    });
    pushEncryptedChangesMock.mockImplementationOnce(async () => {
      order.push('push');
      return { pushed: 3 };
    });

    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(order).toEqual(['delete', 'push']);
  });

  it('records account-state transitions: rotating_e2ee_key then e2ee', async () => {
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    const modes = state.upsertAccountCalls.map((c) => c.mode);
    expect(modes[0]).toBe('rotating_e2ee_key');
    expect(modes[modes.length - 1]).toBe('e2ee');
  });

  it('resets the pull cursor on completion', async () => {
    setPullCursor('2026-05-01T00:00:00.000Z');
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    expect(getPullCursor()).toBeNull();
  });

  it('rejects an incorrect current passphrase before any destructive work', async () => {
    await expect(startE2EEKeyRotation('WRONG', 'NEW_PW')).rejects.toThrow(/OperationError/);
    // No state changes — old bundle still in place, no new DEK minted.
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(OLD_PW),OLD_DEK)');
    expect(generateDek).not.toHaveBeenCalled();
    expect(state.upsertAccountCalls).toHaveLength(0);
    expect(state.saveProfileCalls).toHaveLength(0);
  });
});

describe('startE2EEKeyRotation — panic rotate (same passphrase)', () => {
  it('mints a new DEK + code but keeps the same passphrase wrap', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundleWrappedFor('PW', 'OLD_DEK', 1);

    const result = await startE2EEKeyRotation('PW');

    expect(result.completed).toBe(true);
    expect(result.recoveryCode).toBe('CODE_1');
    expect(state.localBundle?.dekVersion).toBe(2);
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(PW),DEK_1)');
  });
});

describe('startE2EEKeyRotation — resume', () => {
  it('resumes an in-progress rotation by unwrapping the new bundle, not re-minting', async () => {
    // Simulate: rotation already saved a new bundle wrapping DEK_X under NEW_PW.
    state.mockProfile = {
      id: 'profile',
      syncMode: 'rotating_e2ee_key',
      e2eeMigration: {
        id: 'rot-1',
        direction: 'rotate',
        ownerDeviceId: 'device-1',
        startedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    } as ProfileSettings;
    state.localBundle = bundleWrappedFor('NEW_PW', 'DEK_X', 4);

    // Caller passes the new passphrase as the second arg — that's what resume
    // unlocks the bundle with.
    const result = await startE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(result.completed).toBe(true);
    expect(generateDek).not.toHaveBeenCalled();
    expect(generateRecoveryCode).not.toHaveBeenCalled();
    expect(state.saveLocalBundleCalls).toHaveLength(0);
    // No recovery code on resume — the code was returned on the first call.
    expect(result.recoveryCode).toBeUndefined();
  });
});

describe('startE2EEKeyRotation — failure path', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundleWrappedFor('OLD_PW', 'OLD_DEK', 1);
  });

  it('writes a paused rotation state if push fails', async () => {
    pushEncryptedChangesMock.mockRejectedValueOnce(new Error('network down'));

    const result = await startE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(result.completed).toBe(false);
    expect(result.syncMode).toBe('rotating_e2ee_key');
    expect(result.error).toBe('network down');
    // Recovery code surfaces even on a paused rotation so the user has it.
    expect(result.recoveryCode).toBe('CODE_1');
  });
});

describe('resumeE2EEKeyRotation', () => {
  it('requires a passphrase', async () => {
    await expect(resumeE2EEKeyRotation('')).rejects.toThrow(/passphrase is required/i);
  });

  it('rejects when no rotation is in progress', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    await expect(resumeE2EEKeyRotation('pw')).rejects.toThrow(/No key rotation/i);
  });
});

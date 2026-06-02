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
  fetchRemoteCalls: 0,
  generatedDekCounter: 0,
  generatedRecoveryCounter: 0,
}));

vi.mock('$lib/domain/repo', () => ({
  getAllWeights: vi.fn(async () => [
    { id: 'w1', date: '2026-05-01', weightLbs: 180, updatedAt: '2026-05-01T00:00:00.000Z' },
  ]),
  getAllInjections: vi.fn(async () => []),
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
  deriveRecoveryKek: vi.fn(async (code: string) => `RKEK(${code.replace(/[\s-]/g, '').toUpperCase()})`),
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
  fetchRemoteWrappedKeys: vi.fn(async () => {
    state.fetchRemoteCalls += 1;
    return state.remoteBundle ?? null;
  }),
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
  deleteRemotePlainChanges: vi.fn(async () => ({ deleted: 0 })),
  fetchRemoteEncryptedChanges: vi.fn(async () => []),
  pullSnapshotForMigration: vi.fn(async () => ({ fetched: 0, applied: 0 })),
}));

import { recoverWithCode } from './e2ee-migration';
import {
  deriveRecoveryKek,
  generateDek,
  generateRecoveryCode,
  unwrapDek,
} from '$lib/crypto/e2ee';
import { setSessionKey, getSessionKey } from '$lib/sync/session-key';
import { fetchRemoteWrappedKeys, saveLocalWrappedKeys } from '$lib/sync/wrapped-keys';

function bundleForCode(code: string, dekToken: string, passphraseToken = 'OLD_PW'): WrappedKeyBundle {
  return {
    id: 'self',
    dekVersion: 5,
    passphraseSaltB64: 'SALT',
    passphraseWrapped: {
      ciphertext: `wrap(KEK(${passphraseToken}),${dekToken})`,
      iv: 'wiv',
    },
    recoverySaltB64: 'SALT',
    recoveryWrapped: {
      ciphertext: `wrap(RKEK(${code}),${dekToken})`,
      iv: 'wiv',
    },
    updatedAt: '2026-04-01T00:00:00.000Z',
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
  state.fetchRemoteCalls = 0;
  state.generatedDekCounter = 0;
  state.generatedRecoveryCounter = 0;
  pushEncryptedChangesMock.mockClear();
  pushEncryptedChangesMock.mockResolvedValue({ pushed: 0 });
  deleteRemoteEncryptedChangesMock.mockClear();
  deleteRemoteEncryptedChangesMock.mockResolvedValue({ deleted: 0 });
  vi.mocked(deriveRecoveryKek).mockClear();
  vi.mocked(generateDek).mockClear();
  vi.mocked(generateRecoveryCode).mockClear();
  vi.mocked(unwrapDek).mockClear();
  vi.mocked(setSessionKey).mockClear();
  vi.mocked(getSessionKey).mockReturnValue(null);
  vi.mocked(fetchRemoteWrappedKeys).mockClear();
  vi.mocked(saveLocalWrappedKeys).mockClear();
});

describe('recoverWithCode — argument validation', () => {
  it('requires a recovery code', async () => {
    await expect(recoverWithCode('', 'newpw')).rejects.toThrow(/recovery code is required/i);
    await expect(recoverWithCode('   ', 'newpw')).rejects.toThrow(/recovery code is required/i);
  });

  it('requires a new passphrase', async () => {
    await expect(recoverWithCode('CODE', '')).rejects.toThrow(/new passphrase is required/i);
  });
});

describe('recoverWithCode — same device (local bundle present)', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundleForCode('OLDCODE', 'OLD_DEK');
  });

  it('unwraps via the recovery KEK and runs a full rotation under the new passphrase', async () => {
    const result = await recoverWithCode('OLDCODE', 'NEW_PW');

    expect(result.completed).toBe(true);
    expect(result.syncMode).toBe('e2ee');
    // A fresh DEK + recovery code were minted (not the old ones).
    expect(generateDek).toHaveBeenCalledTimes(1);
    expect(generateRecoveryCode).toHaveBeenCalledTimes(1);
    expect(result.recoveryCode).toBe('CODE_1');
    // New bundle wraps the new DEK under the new passphrase.
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(NEW_PW),DEK_1)');
    // dekVersion bumped.
    expect(state.localBundle?.dekVersion).toBe(6);
  });

  it('rejects an incorrect recovery code with a clean error (no destructive work)', async () => {
    await expect(recoverWithCode('WRONG-CODE', 'NEW_PW')).rejects.toThrow(/didn't unlock/i);
    // No rotation happened.
    expect(generateDek).not.toHaveBeenCalled();
    expect(state.upsertAccountCalls).toHaveLength(0);
    expect(state.saveProfileCalls).toHaveLength(0);
    // Bundle untouched.
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(OLD_PW),OLD_DEK)');
  });

  it('normalizes the code (dashes/spaces/case) before deriving the recovery KEK', async () => {
    // bundleForCode stored the recoveryWrapped as `wrap(RKEK(OLDCODE),...)`.
    // The user pastes the code with dashes and lowercased — the recovery
    // KEK derivation must normalize back to OLDCODE.
    await expect(recoverWithCode('old-code', 'NEW_PW')).resolves.toMatchObject({ completed: true });
  });

  it('does not fetch from the remote when a local bundle is present', async () => {
    await recoverWithCode('OLDCODE', 'NEW_PW');
    expect(state.fetchRemoteCalls).toBe(0);
  });
});

describe('recoverWithCode — new device (no local bundle, server has one)', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    state.localBundle = undefined;
    state.remoteBundle = bundleForCode('OLDCODE', 'OLD_DEK');
  });

  it('fetches the bundle from the server and runs recovery as usual', async () => {
    const result = await recoverWithCode('OLDCODE', 'NEW_PW');

    expect(state.fetchRemoteCalls).toBe(1);
    expect(saveLocalWrappedKeys).toHaveBeenCalled(); // local mirror written before rotation
    expect(result.completed).toBe(true);
    expect(result.recoveryCode).toBe('CODE_1');
  });

  it('upgrades the profile from plain to e2ee before the rotation runs', async () => {
    await recoverWithCode('OLDCODE', 'NEW_PW');
    // First saveProfile sets passphraseEnabled + syncMode=e2ee so the
    // rotation's prelude accepts the call.
    expect(state.saveProfileCalls[0]).toMatchObject({
      passphraseEnabled: true,
      syncMode: 'e2ee',
    });
  });

  it("throws cleanly when no account exists on the server either", async () => {
    state.remoteBundle = undefined;
    await expect(recoverWithCode('OLDCODE', 'NEW_PW')).rejects.toThrow(/No encrypted account/i);
  });
});

describe('recoverWithCode — old code stops working after rotation', () => {
  it('rotates the recoveryWrapped so the original code no longer unwraps', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundleForCode('OLDCODE', 'OLD_DEK');

    await recoverWithCode('OLDCODE', 'NEW_PW');

    // The new bundle's recoveryWrapped is `wrap(RKEK(CODE_1), DEK_1)` — using
    // the original code now resolves to a different RKEK, so unwrap fails.
    await expect(recoverWithCode('OLDCODE', 'ANOTHER_NEW')).rejects.toThrow(/didn't unlock/i);
  });
});

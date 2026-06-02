import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import type {
  E2EEMigrationState,
  ProfileSettings,
  SyncMode,
  WrappedKeyBundle,
} from '$lib/domain/types';

// ── Mutable state used by mocks ───────────────────────────────────────────
// Use vi.hoisted so the state exists before vi.mock factories run (factories
// are hoisted above the imports).
const state = vi.hoisted(() => ({
  mockProfile: undefined as ProfileSettings | undefined,
  saveProfileCalls: [] as Array<Partial<ProfileSettings>>,
  upsertAccountCalls: [] as Array<{ mode: SyncMode; migration?: E2EEMigrationState }>,
  localBundle: undefined as WrappedKeyBundle | undefined,
  remoteBundle: undefined as WrappedKeyBundle | undefined,
  saveLocalBundleCalls: [] as Array<Omit<WrappedKeyBundle, 'id'>>,
  upsertRemoteBundleCalls: [] as WrappedKeyBundle[],
  clearLocalCalls: 0,
  deleteRemoteCalls: 0,
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
  generateDek: vi.fn(async () => 'DEK_BYTES'),
  generateRecoveryCode: vi.fn(() => 'TEST-RECO-CODE-2026'),
  generateSaltB64: vi.fn(() => 'SALT'),
  derivePassphraseKek: vi.fn(async (passphrase: string) => `KEK(${passphrase})`),
  deriveRecoveryKek: vi.fn(async () => 'RKEK'),
  wrapDek: vi.fn(async (kek: string, dek: string) => ({
    ciphertext: `wrap(${kek},${dek})`,
    iv: 'wiv',
  })),
  unwrapDek: vi.fn(async (kek: string, ciphertext: string) => {
    // Inverse of the wrap mock above: parses `wrap(kek,dek)` back to `dek`,
    // but only if the kek matches. Lets disable/resume tests verify that the
    // right passphrase was passed in.
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
    state.clearLocalCalls += 1;
    state.localBundle = undefined;
  }),
  fetchRemoteWrappedKeys: vi.fn(async () => state.remoteBundle ?? null),
  upsertRemoteWrappedKeys: vi.fn(async (bundle: WrappedKeyBundle) => {
    state.upsertRemoteBundleCalls.push(bundle);
    state.remoteBundle = bundle;
  }),
  deleteRemoteWrappedKeys: vi.fn(async () => {
    state.deleteRemoteCalls += 1;
    state.remoteBundle = undefined;
  }),
}));

const pushEncryptedChangesMock = vi.fn(async (..._args: unknown[]) => ({ pushed: 0 }));
const pushPlainChangesMock = vi.fn(async (..._args: unknown[]) => ({ pushed: 0 }));
const deleteRemoteEncryptedChangesMock = vi.fn(async (..._args: unknown[]) => ({ deleted: 0 }));
const deleteRemotePlainChangesMock = vi.fn(async (..._args: unknown[]) => ({ deleted: 0 }));
const fetchRemoteEncryptedChangesMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const pullSnapshotForMigrationMock = vi.fn(async (..._args: unknown[]) => ({ fetched: 0, applied: 0 }));

vi.mock('$lib/sync/sync-engine', () => ({
  pushEncryptedChanges: (...args: unknown[]) => pushEncryptedChangesMock(...args),
  pushPlainChanges: (...args: unknown[]) => pushPlainChangesMock(...args),
  deleteRemoteEncryptedChanges: (...args: unknown[]) => deleteRemoteEncryptedChangesMock(...args),
  deleteRemotePlainChanges: (...args: unknown[]) => deleteRemotePlainChangesMock(...args),
  fetchRemoteEncryptedChanges: (...args: unknown[]) => fetchRemoteEncryptedChangesMock(...args),
  pullSnapshotForMigration: (...args: unknown[]) => pullSnapshotForMigrationMock(...args),
}));

// Imports MUST come after vi.mock so the mocks are applied.
import {
  autoResumeMigration,
  resumeE2EEDisableMigration,
  resumeE2EEMigration,
  startE2EEDisableMigration,
  startE2EEMigration,
  takeOverMigration,
} from './e2ee-migration';
import { db } from '$lib/db/schema';
import {
  decryptRecord,
  derivePassphraseKek,
  deriveRecoveryKek,
  encryptRecord,
  generateDek,
  generateRecoveryCode,
  generateSaltB64,
  unwrapDek,
  wrapDek,
} from '$lib/crypto/e2ee';
import {
  clearLocalWrappedKeys,
  deleteRemoteWrappedKeys,
  saveLocalWrappedKeys,
  upsertRemoteWrappedKeys,
} from '$lib/sync/wrapped-keys';
import { clearSession, getSessionKey, setSessionKey } from '$lib/sync/session-key';
import { clearPullCursor, getPullCursor, setPullCursor } from '$lib/sync/pull-cursor';

function bundleFor(passphrase: string): WrappedKeyBundle {
  // Matches the wrap mock: ciphertext is `wrap(KEK(passphrase),DEK_BYTES)`.
  return {
    id: 'self',
    dekVersion: 1,
    passphraseSaltB64: 'SALT',
    passphraseWrapped: {
      ciphertext: `wrap(KEK(${passphrase}),DEK_BYTES)`,
      iv: 'wiv',
    },
    recoverySaltB64: 'SALT',
    recoveryWrapped: { ciphertext: 'wrap(RKEK,DEK_BYTES)', iv: 'wiv' },
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
  state.clearLocalCalls = 0;
  state.deleteRemoteCalls = 0;
  pushEncryptedChangesMock.mockClear();
  pushEncryptedChangesMock.mockResolvedValue({ pushed: 0 });
  pushPlainChangesMock.mockClear();
  pushPlainChangesMock.mockResolvedValue({ pushed: 0 });
  deleteRemoteEncryptedChangesMock.mockClear();
  deleteRemoteEncryptedChangesMock.mockResolvedValue({ deleted: 0 });
  deleteRemotePlainChangesMock.mockClear();
  deleteRemotePlainChangesMock.mockResolvedValue({ deleted: 0 });
  fetchRemoteEncryptedChangesMock.mockClear();
  fetchRemoteEncryptedChangesMock.mockResolvedValue([]);
  pullSnapshotForMigrationMock.mockClear();
  pullSnapshotForMigrationMock.mockResolvedValue({ fetched: 0, applied: 0 });
  vi.mocked(encryptRecord).mockClear();
  vi.mocked(decryptRecord).mockClear();
  vi.mocked(generateDek).mockClear();
  vi.mocked(generateRecoveryCode).mockClear();
  vi.mocked(generateSaltB64).mockClear();
  vi.mocked(derivePassphraseKek).mockClear();
  vi.mocked(deriveRecoveryKek).mockClear();
  vi.mocked(wrapDek).mockClear();
  vi.mocked(unwrapDek).mockClear();
  vi.mocked(saveLocalWrappedKeys).mockClear();
  vi.mocked(upsertRemoteWrappedKeys).mockClear();
  vi.mocked(clearLocalWrappedKeys).mockClear();
  vi.mocked(deleteRemoteWrappedKeys).mockClear();
  vi.mocked(setSessionKey).mockClear();
  vi.mocked(clearSession).mockClear();
  vi.mocked(getSessionKey).mockReturnValue(null);
  clearPullCursor();
});

describe('startE2EEMigration — argument validation', () => {
  it('requires a non-empty passphrase', async () => {
    await expect(startE2EEMigration('')).rejects.toThrow(/passphrase is required/i);
  });

  it('throws when E2EE is already enabled', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    await expect(startE2EEMigration('pw')).rejects.toThrow(/already enabled/i);
  });

  it('throws when a key rotation is mid-flight', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'rotating_e2ee_key' } as ProfileSettings;
    await expect(startE2EEMigration('pw')).rejects.toThrow(/key rotation/i);
  });
});

describe('startE2EEMigration — happy path from plain', () => {
  it('mints a DEK + recovery code, wraps both, and persists the bundle locally and remotely', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    pushEncryptedChangesMock.mockResolvedValueOnce({ pushed: 2 });

    const result = await startE2EEMigration('hunter2');

    expect(generateDek).toHaveBeenCalledTimes(1);
    expect(generateRecoveryCode).toHaveBeenCalledTimes(1);
    expect(derivePassphraseKek).toHaveBeenCalledWith('hunter2', expect.any(String));
    expect(deriveRecoveryKek).toHaveBeenCalledWith('TEST-RECO-CODE-2026', expect.any(String));
    // DEK wrapped under both KEKs.
    expect(wrapDek).toHaveBeenCalledTimes(2);
    expect(saveLocalWrappedKeys).toHaveBeenCalledTimes(1);
    expect(upsertRemoteWrappedKeys).toHaveBeenCalledTimes(1);

    expect(result.syncMode).toBe('e2ee');
    expect(result.completed).toBe(true);
    expect(result.recoveryCode).toBe('TEST-RECO-CODE-2026');
    expect(result.encryptedEventCount).toBeGreaterThan(0);
    expect(result.pushed).toBe(2);
    expect(result.migration.completedAt).toBeTruthy();
  });

  it('caches the DEK in memory via setSessionKey', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('hunter2');
    expect(setSessionKey).toHaveBeenCalledWith('DEK_BYTES');
  });

  it('encrypts every aggregate (weights + injections + profile) under the DEK', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('pw');

    // 1 weight + 1 injection + 1 profile = 3.
    expect(vi.mocked(encryptRecord).mock.calls.length).toBe(3);
    // All encryptRecord calls use the DEK, not a passphrase-derived key.
    for (const call of vi.mocked(encryptRecord).mock.calls) {
      expect(call[0]).toBe('DEK_BYTES');
    }
    const entries = await db.migrationBackfill.toArray();
    expect(entries.length).toBe(3);
    const aggregates = new Set(entries.map((e) => e.aggregate));
    expect(aggregates).toEqual(new Set(['weight', 'injection', 'profile']));
  });

  it('marks the profile as passphraseEnabled and syncMode=e2ee on success', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('pw');
    const finalSave = state.saveProfileCalls[state.saveProfileCalls.length - 1];
    expect(finalSave).toMatchObject({
      passphraseEnabled: true,
      syncMode: 'e2ee',
    });
  });

  it('resets the pull cursor — steady-state sync now reads a different table', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    setPullCursor('2026-05-01T00:00:00.000Z');
    await startE2EEMigration('pw');
    expect(getPullCursor()).toBeNull();
  });

  it('records account-state transitions: migrating_to_e2ee then e2ee', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('pw');
    const modes = state.upsertAccountCalls.map((c) => c.mode);
    expect(modes[0]).toBe('migrating_to_e2ee');
    expect(modes[modes.length - 1]).toBe('e2ee');
  });

  it('pulls a remote snapshot under the DEK before re-encrypting', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('pw');
    // The snapshot pull absorbs server-only rows so the plaintext teardown
    // below can't lose data. It must run under the minted DEK.
    expect(pullSnapshotForMigrationMock).toHaveBeenCalledWith('DEK_BYTES');
  });

  it('deletes the remote plaintext rows once the encrypted copies are pushed', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('pw');
    // Enabling E2EE must not leave readable PHI in sync_changes_plain.
    expect(deleteRemotePlainChangesMock).toHaveBeenCalled();
  });

  it('does not delete plaintext when the encrypted push fails (stays paused)', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    pushEncryptedChangesMock.mockRejectedValueOnce(new Error('network down'));

    const result = await startE2EEMigration('pw');

    expect(result.completed).toBe(false);
    // Deleting plaintext before the encrypted copies are safely on the server
    // would be data loss — finish() is never reached on a failed push.
    expect(deleteRemotePlainChangesMock).not.toHaveBeenCalled();
  });

  it('wipes any residual encrypted state from a prior interrupted attempt before minting', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    // Pretend an earlier failed run left a stale local bundle behind.
    state.localBundle = bundleFor('OLD_PASSPHRASE');

    await startE2EEMigration('pw');

    expect(clearLocalWrappedKeys).not.toHaveBeenCalled(); // direct table .clear() handles it
    expect(deleteRemoteWrappedKeys).toHaveBeenCalled();
    // A fresh bundle was minted (saveLocalWrappedKeys called with new content).
    expect(saveLocalWrappedKeys).toHaveBeenCalled();
  });
});

describe('startE2EEMigration — resume', () => {
  it('resumes an in-progress migration by unwrapping the existing bundle, not minting a new one', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: {
        id: 'mig-x',
        ownerDeviceId: 'device-1',
        startedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    } as ProfileSettings;
    state.localBundle = bundleFor('pw');

    const result = await startE2EEMigration('pw');

    // A resume must not mint a fresh DEK or code — that would orphan the
    // already-encrypted backfill rows.
    expect(generateDek).not.toHaveBeenCalled();
    expect(generateRecoveryCode).not.toHaveBeenCalled();
    expect(saveLocalWrappedKeys).not.toHaveBeenCalled();
    expect(result.completed).toBe(true);
    expect(result.syncMode).toBe('e2ee');
    expect(result.recoveryCode).toBeUndefined();
  });

  it('rejects with a clear error when no local bundle exists to unwrap', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: {
        id: 'mig-x',
        ownerDeviceId: 'device-1',
        startedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    } as ProfileSettings;
    state.localBundle = undefined;

    const result = await startE2EEMigration('pw');
    // Failure surfaces as a paused migration with the error captured.
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/wrapped-key bundle/i);
  });
});

describe('startE2EEMigration — failure path', () => {
  it('writes failedMigration state and returns completed=false on push failure', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    pushEncryptedChangesMock.mockRejectedValueOnce(new Error('network down'));

    const result = await startE2EEMigration('pw');

    expect(result.completed).toBe(false);
    expect(result.syncMode).toBe('migrating_to_e2ee');
    expect(result.error).toBe('network down');
    expect(result.migration.lastError).toBe('network down');
    // The recovery code is still surfaced so the user has it after a paused run.
    expect(result.recoveryCode).toBe('TEST-RECO-CODE-2026');
  });
});

describe('resumeE2EEMigration', () => {
  it('rejects when no migration is in progress', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await expect(resumeE2EEMigration('pw')).rejects.toThrow(/No E2EE migration is in progress/i);
  });

  it('rejects an empty passphrase', async () => {
    await expect(resumeE2EEMigration('')).rejects.toThrow(/passphrase is required/i);
  });
});

describe('startE2EEDisableMigration — argument validation', () => {
  it('requires a passphrase', async () => {
    await expect(startE2EEDisableMigration('')).rejects.toThrow(/passphrase is required/i);
  });

  it('rejects when E2EE is already disabled (sync mode is plain)', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await expect(startE2EEDisableMigration('pw')).rejects.toThrow(/already disabled/i);
  });

  it('rejects when an enable-migration is still in progress', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'migrating_to_e2ee' } as ProfileSettings;
    await expect(startE2EEDisableMigration('pw')).rejects.toThrow(/Finish the current encryption migration/i);
  });
});

describe('startE2EEDisableMigration — happy path from e2ee', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundleFor('pw');
  });

  it('decrypts remote events when present and pushes them as plain events', async () => {
    fetchRemoteEncryptedChangesMock.mockResolvedValueOnce([
      {
        id: 'r-1',
        aggregate: 'weight',
        op: 'upsert',
        ciphertext: 'ct:{"aggregate":"weight","op":"upsert","record":{"id":"w99"}}',
        iv: 'iv',
        protocolVersion: 1,
        encryptionVersion: 1,
        schemaVersion: 1,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    pushPlainChangesMock.mockResolvedValueOnce({ pushed: 1 });
    deleteRemoteEncryptedChangesMock.mockResolvedValueOnce({ deleted: 1 });

    const result = await startE2EEDisableMigration('pw');

    expect(result.completed).toBe(true);
    expect(result.syncMode).toBe('plain');
    expect(result.plaintextEventCount).toBe(1);
    expect(result.deletedEncryptedEventCount).toBe(1);
    expect(pushPlainChangesMock).toHaveBeenCalledTimes(1);
    const eventsArg = pushPlainChangesMock.mock.calls[0]?.[0] as Array<{ aggregate: string }>;
    expect(Array.isArray(eventsArg)).toBe(true);
    expect(eventsArg[0].aggregate).toBe('weight');
  });

  it('resets the pull cursor when E2EE is disabled', async () => {
    setPullCursor('2026-05-01T00:00:00.000Z');
    await startE2EEDisableMigration('pw');
    expect(getPullCursor()).toBeNull();
  });

  it('falls back to collecting plain events from local records when no encrypted events exist', async () => {
    fetchRemoteEncryptedChangesMock.mockResolvedValueOnce([]);
    pushPlainChangesMock.mockResolvedValueOnce({ pushed: 3 });

    const result = await startE2EEDisableMigration('pw');

    expect(result.completed).toBe(true);
    // weights(1) + injections(1) + profile(1) = 3 plain events
    expect(result.plaintextEventCount).toBe(3);
    expect(pushPlainChangesMock).toHaveBeenCalledTimes(1);
  });

  it('clears the wrapped-key bundle (local + remote) on success and switches profile to plain', async () => {
    await startE2EEDisableMigration('pw');
    expect(clearLocalWrappedKeys).toHaveBeenCalled();
    expect(deleteRemoteWrappedKeys).toHaveBeenCalled();
    expect(clearSession).toHaveBeenCalled();
    const finalSave = state.saveProfileCalls[state.saveProfileCalls.length - 1];
    expect(finalSave).toMatchObject({ passphraseEnabled: false, syncMode: 'plain' });
  });

  it('clears local encrypted + migrationBackfill tables on success', async () => {
    await db.migrationBackfill.put({
      id: 'leftover',
      aggregate: 'weight',
      op: 'upsert',
      payloadCiphertext: 'ct:{"aggregate":"weight","op":"upsert","record":{"id":"w99"}}',
      payloadIv: 'iv',
      protocolVersion: 1,
      encryptionVersion: 1,
      schemaVersion: 1,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    await db.encrypted.put({
      id: 'weight:w99',
      entity: 'weight',
      ciphertext: 'ct',
      iv: 'iv',
      keyVersion: 1,
      updatedAt: '2026-05-01T00:00:00.000Z',
    });

    await startE2EEDisableMigration('pw');

    expect(await db.migrationBackfill.count()).toBe(0);
    expect(await db.encrypted.count()).toBe(0);
  });

  it('marks the migration failed if pushPlainChanges throws', async () => {
    pushPlainChangesMock.mockRejectedValueOnce(new Error('push-fail'));

    const result = await startE2EEDisableMigration('pw');

    expect(result.completed).toBe(false);
    expect(result.syncMode).toBe('migrating_to_plain');
    expect(result.error).toBe('push-fail');
    expect(clearLocalWrappedKeys).not.toHaveBeenCalled();
    expect(deleteRemoteWrappedKeys).not.toHaveBeenCalled();
  });

  it('rejects when the supplied passphrase does not unwrap the local bundle', async () => {
    // Local bundle is wrapped for 'pw'; try unlocking with the wrong one.
    const result = await startE2EEDisableMigration('wrong');
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/OperationError/);
    expect(clearLocalWrappedKeys).not.toHaveBeenCalled();
  });
});

describe('resumeE2EEDisableMigration', () => {
  it('requires a passphrase', async () => {
    await expect(resumeE2EEDisableMigration('')).rejects.toThrow(/passphrase is required/i);
  });

  it('throws when no disable-migration is active', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    await expect(resumeE2EEDisableMigration('pw')).rejects.toThrow(/No E2EE disable migration/i);
  });
});

describe('autoResumeMigration — crash recovery', () => {
  const ownedMigration = (direction: 'enable' | 'disable' | 'rotate') => ({
    id: 'mig-x',
    direction,
    ownerDeviceId: 'device-1', // matches the getDeviceId mock
    startedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });

  it('is idle in a steady-state mode (nothing to resume)', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    expect(await autoResumeMigration()).toEqual({ status: 'idle' });
  });

  it('offers a take-over when the migration is owned by another device', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: { ...ownedMigration('enable'), ownerDeviceId: 'some-other-device' },
    } as ProfileSettings;
    vi.mocked(getSessionKey).mockReturnValue('DEK_BYTES');
    expect(await autoResumeMigration()).toMatchObject({
      status: 'awaiting-takeover',
      direction: 'enable',
      ownerDeviceId: 'some-other-device',
    });
  });

  it('reports progress + heartbeat with the take-over offer', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: {
        ...ownedMigration('enable'),
        ownerDeviceId: 'some-other-device',
        recordsConverted: 3,
        recordsTotal: 10,
        updatedAt: '2026-05-01T00:00:05.000Z',
      },
    } as ProfileSettings;

    expect(await autoResumeMigration()).toMatchObject({
      status: 'awaiting-takeover',
      recordsConverted: 3,
      recordsTotal: 10,
      updatedAt: '2026-05-01T00:00:05.000Z',
    });
  });

  it('needs the passphrase when the session is locked mid-migration', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: ownedMigration('enable'),
    } as ProfileSettings;
    vi.mocked(getSessionKey).mockReturnValue(null);

    expect(await autoResumeMigration()).toEqual({
      status: 'needs-passphrase',
      direction: 'enable',
    });
  });

  it('resumes an enable migration to completion with the cached DEK', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: ownedMigration('enable'),
    } as ProfileSettings;
    state.localBundle = bundleFor('pw');
    vi.mocked(getSessionKey).mockReturnValue('DEK_BYTES');

    const outcome = await autoResumeMigration();

    expect(outcome.status).toBe('resumed');
    expect(outcome).toMatchObject({ result: { completed: true, syncMode: 'e2ee' } });
    // Recovery completed the privacy-critical teardown.
    expect(deleteRemotePlainChangesMock).toHaveBeenCalled();
    // No fresh key/code minted on a resume.
    expect(generateDek).not.toHaveBeenCalled();
  });

  it('resumes a disable migration to plain with the cached DEK', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_plain',
      e2eeMigration: ownedMigration('disable'),
    } as ProfileSettings;
    state.localBundle = bundleFor('pw');
    vi.mocked(getSessionKey).mockReturnValue('DEK_BYTES');

    const outcome = await autoResumeMigration();

    expect(outcome.status).toBe('resumed');
    expect(outcome).toMatchObject({ result: { completed: true, syncMode: 'plain' } });
  });

  it('reports paused (not resumed) when the resume attempt fails', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: ownedMigration('enable'),
    } as ProfileSettings;
    state.localBundle = bundleFor('pw');
    vi.mocked(getSessionKey).mockReturnValue('DEK_BYTES');
    pushEncryptedChangesMock.mockRejectedValueOnce(new Error('network down'));

    const outcome = await autoResumeMigration();

    expect(outcome.status).toBe('paused');
    expect(outcome).toMatchObject({ result: { completed: false, error: 'network down' } });
  });
});

describe('takeOverMigration', () => {
  it('stamps this device as owner locally and on the server', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: {
        id: 'mig-x',
        direction: 'enable',
        ownerDeviceId: 'some-other-device',
        startedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    } as ProfileSettings;

    await takeOverMigration();

    const saved = state.saveProfileCalls.at(-1);
    expect(saved?.e2eeMigration?.ownerDeviceId).toBe('device-1'); // the getDeviceId mock
    const account = state.upsertAccountCalls.at(-1);
    expect(account?.mode).toBe('migrating_to_e2ee');
    expect(account?.migration?.ownerDeviceId).toBe('device-1');
  });

  it('throws when there is no in-progress migration to take over', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    await expect(takeOverMigration()).rejects.toThrow(/no in-progress migration/i);
  });
});

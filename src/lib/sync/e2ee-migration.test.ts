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
  beginTransitionCalls: [] as Array<{ from: SyncMode[]; to: SyncMode }>,
  completeTransitionCalls: [] as Array<{
    migrationId: string;
    ownerDeviceId: string;
    to: SyncMode;
    activeDekVersion: number | null;
  }>,
  claimOwnerCalls: [] as Array<{
    migrationId: string;
    expectedOwnerDeviceId: string;
    newOwnerDeviceId: string;
  }>,
  heartbeatCalls: [] as E2EEMigrationState[],
  localBundle: undefined as WrappedKeyBundle | undefined,
  remoteBundle: undefined as WrappedKeyBundle | undefined,
  saveLocalBundleCalls: [] as Array<Omit<WrappedKeyBundle, 'id'>>,
  upsertRemoteBundleCalls: [] as WrappedKeyBundle[],
  clearLocalCalls: 0,
  deleteRemoteCalls: 0,
  destinationVerificationError: undefined as Error | undefined,
}));

vi.mock('$lib/domain/health-data-storage', () => ({
  hasPlainHealthData: vi.fn(async () => false),
  getAllEntries: vi.fn(async () => [
    { id: 'w1', date: '2026-05-01', weightLbs: 180, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
    { id: 'i1', date: '2026-05-01', amountMg: 5, medication: 'Semaglutide (Ozempic / Wegovy)', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
  ]),
  getAllPrescriptions: vi.fn(async () => []),
  getProfile: vi.fn(async () => state.mockProfile && ({
    ...state.mockProfile,
    id: 'profile',
    createdAt: state.mockProfile.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: state.mockProfile.updatedAt ?? '2026-05-09T00:00:00.000Z',
    passphraseEnabled: state.mockProfile.passphraseEnabled ?? false,
  } as ProfileSettings)),
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
  PBKDF2_ITERATIONS: 600000,
  LEGACY_PBKDF2_ITERATIONS: 210000,
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
    const envelope = JSON.parse(ciphertext.replace(/^ct:/, ''));
    if (envelope.op === 'upsert' && envelope.record && envelope.aggregate === 'entry') {
      envelope.record = {
        date: '2026-05-01', createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z', ...envelope.record,
      };
    }
    return envelope;
  }),
}));

vi.mock('$lib/sync/session-key', () => ({
  setSessionKey: vi.fn(),
  clearSession: vi.fn(),
  getSessionKey: vi.fn(() => null),
  hasSessionKey: vi.fn(() => false),
}));

vi.mock('$lib/sync/account-state', () => ({
  getDeviceId: vi.fn(() => 'device-1'),
  advanceSyncTransitionPhase: vi.fn(async () => undefined),
  startFreshSync: vi.fn(async () => undefined),
  upsertRemoteSyncAccount: vi.fn(async (mode: SyncMode, migration?: E2EEMigrationState) => {
    state.upsertAccountCalls.push({ mode, migration });
  }),
  beginSyncTransition: vi.fn(
    async (t: { from: SyncMode[]; to: SyncMode; allocateNewDek: boolean }) => {
      state.beginTransitionCalls.push({ from: t.from, to: t.to });
      // Server allocates next version off the local bundle's (the test's stand-in
      // for the server's active version).
      const active = state.localBundle?.dekVersion ?? null;
      return {
        activeDekVersion: active,
        pendingDekVersion: t.allocateNewDek ? (active ?? 0) + 1 : null,
      };
    },
  ),
  SyncTransitionConflictError: class extends Error {},
  MigrationSupersededError: class extends Error {},
  // Owner-scoped progress/liveness heartbeat: records the call but never writes
  // a mode (mirrors the production helper, which is scoped to the owning device).
  heartbeatMigrationProgress: vi.fn(async (migration: E2EEMigrationState) => {
    state.heartbeatCalls.push(migration);
  }),
  // Guarded finalize: stand-in for the `complete_sync_transition` RPC.
  completeSyncTransition: vi.fn(
    async (p: {
      migrationId: string;
      ownerDeviceId: string;
      to: SyncMode;
      activeDekVersion: number | null;
    }) => {
      state.completeTransitionCalls.push(p);
    },
  ),
  // Atomic take-over CAS: stand-in for the `claim_migration_owner` RPC.
  claimMigrationOwner: vi.fn(
    async (p: { migrationId: string; expectedOwnerDeviceId: string; newOwnerDeviceId: string }) => {
      state.claimOwnerCalls.push(p);
    },
  ),
  // Ownership re-check used by assertStillMigrationOwner: reflect back the
  // current profile's migration so the happy paths (owner === this device) pass.
  fetchRemoteSyncAccount: vi.fn(async () => ({
    syncMode: state.mockProfile?.syncMode ?? 'plain',
    migration: state.mockProfile?.e2eeMigration,
    activeDekVersion: state.localBundle?.dekVersion ?? null,
    pendingDekVersion: null,
  })),
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
const fetchRemotePlainChangesMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const pullSnapshotForMigrationMock = vi.fn(async (..._args: unknown[]) => ({ fetched: 0, applied: 0 }));

vi.mock('$lib/sync/sync-engine', () => ({
  pushEncryptedChanges: (...args: unknown[]) => pushEncryptedChangesMock(...args),
  pushPlainChanges: (...args: unknown[]) => pushPlainChangesMock(...args),
  deleteRemoteEncryptedChanges: (...args: unknown[]) => deleteRemoteEncryptedChangesMock(...args),
  deleteRemotePlainChanges: (...args: unknown[]) => deleteRemotePlainChangesMock(...args),
  fetchRemoteEncryptedChanges: (...args: unknown[]) => fetchRemoteEncryptedChangesMock(...args),
  fetchRemotePlainChanges: (...args: unknown[]) => fetchRemotePlainChangesMock(...args),
  pullSnapshotForMigration: (...args: unknown[]) => pullSnapshotForMigrationMock(...args),
  reEncryptServerRows: vi.fn(async () => 0),
}));

vi.mock('$lib/sync/remote-sync-log-transfer', () => ({
  remoteSyncLogTransfer: {
    createProgressReporter: (migration: E2EEMigrationState) => async (converted: number, total: number) => {
      Object.assign(migration, { recordsConverted: converted, recordsTotal: total });
      const account = await import('$lib/sync/account-state');
      await account.heartbeatMigrationProgress(migration);
    },
    heartbeat: async (migration: E2EEMigrationState) => {
      const account = await import('$lib/sync/account-state');
      return account.heartbeatMigrationProgress(migration);
    },
    readEncrypted: (...args: unknown[]) => fetchRemoteEncryptedChangesMock(...args),
    readPlain: (...args: unknown[]) => fetchRemotePlainChangesMock(...args),
    removeEncrypted: (...args: unknown[]) => deleteRemoteEncryptedChangesMock(...args),
    rotateCiphertext: vi.fn(async () => 0),
    copyEncryptedThenRemovePlain: async (options: {
      migration: E2EEMigrationState;
    }) => {
      const account = await import('$lib/sync/account-state');
      await account.advanceSyncTransitionPhase({
        migrationId: options.migration.id, ownerDeviceId: options.migration.ownerDeviceId, phase: 'transferring',
      });
      options.migration.phase = 'transferring';
      const pushed = await pushEncryptedChangesMock({ allowMigrating: true });
      await account.advanceSyncTransitionPhase({
        migrationId: options.migration.id, ownerDeviceId: options.migration.ownerDeviceId, phase: 'verifying',
      });
      options.migration.phase = 'verifying';
      if (state.destinationVerificationError) throw state.destinationVerificationError;
      const remote = await account.fetchRemoteSyncAccount();
      if (remote?.migration?.ownerDeviceId !== 'device-1') throw new account.MigrationSupersededError();
      await deleteRemotePlainChangesMock();
      return pushed;
    },
    copyPlainThenRemoveEncrypted: async (options: {
      changes: unknown[];
      migration: E2EEMigrationState;
    }) => {
      const account = await import('$lib/sync/account-state');
      await fetchRemoteEncryptedChangesMock();
      await account.advanceSyncTransitionPhase({
        migrationId: options.migration.id, ownerDeviceId: options.migration.ownerDeviceId, phase: 'transferring',
      });
      options.migration.phase = 'transferring';
      const pushed = await pushPlainChangesMock(options.changes);
      await account.advanceSyncTransitionPhase({
        migrationId: options.migration.id, ownerDeviceId: options.migration.ownerDeviceId, phase: 'verifying',
      });
      options.migration.phase = 'verifying';
      const remote = await account.fetchRemoteSyncAccount();
      if (remote?.migration?.ownerDeviceId !== 'device-1') throw new account.MigrationSupersededError();
      const deleted = await deleteRemoteEncryptedChangesMock();
      await fetchRemoteEncryptedChangesMock();
      return { pushed: pushed.pushed, deleted: deleted.deleted };
    },
  },
}));

// Imports MUST come after vi.mock so the mocks are applied.
import {
  autoResumeMigration,
  isMigrationRunInProgress,
  resumeE2EEDisableMigration,
  resumeE2EEMigration,
  resetEncryptionToPlain,
  startFreshToPlain,
  startE2EEDisableMigration,
  startE2EEMigration,
  takeOverMigration,
} from './e2ee-migration';
import { db } from '$lib/db/schema';
import {
  beginSyncTransition,
  claimMigrationOwner,
  completeSyncTransition,
  fetchRemoteSyncAccount,
  MigrationSupersededError,
  startFreshSync,
  SyncTransitionConflictError,
} from '$lib/sync/account-state';
import { getAllEntries } from '$lib/domain/health-data-storage';
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
import { createE2EELifecycle } from '$lib/sync/e2ee-lifecycle';
import {
  productionE2EETransitionExecutor,
  type RuntimeE2EELifecycleResults,
} from '$lib/sync/e2ee-transition-executor';

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
    passphraseIterations: 600_000,
    recoveryStatus: 'confirmed',
    recoverySaltB64: 'SALT',
    recoveryWrapped: { ciphertext: 'wrap(RKEK,DEK_BYTES)', iv: 'wiv' },
    recoveryIterations: 600_000,
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  state.mockProfile = undefined;
  state.saveProfileCalls.length = 0;
  state.upsertAccountCalls.length = 0;
  state.beginTransitionCalls.length = 0;
  state.completeTransitionCalls.length = 0;
  state.claimOwnerCalls.length = 0;
  state.heartbeatCalls.length = 0;
  state.localBundle = undefined;
  state.remoteBundle = undefined;
  state.saveLocalBundleCalls.length = 0;
  state.upsertRemoteBundleCalls.length = 0;
  state.clearLocalCalls = 0;
  state.deleteRemoteCalls = 0;
  state.destinationVerificationError = undefined;
  pushEncryptedChangesMock.mockClear();
  pushEncryptedChangesMock.mockResolvedValue({ pushed: 0 });
  pushPlainChangesMock.mockClear();
  pushPlainChangesMock.mockResolvedValue({ pushed: 0 });
  deleteRemoteEncryptedChangesMock.mockClear();
  deleteRemoteEncryptedChangesMock.mockImplementation(async () => {
    fetchRemoteEncryptedChangesMock.mockResolvedValue([]);
    return { deleted: 0 };
  });
  deleteRemotePlainChangesMock.mockClear();
  deleteRemotePlainChangesMock.mockImplementation(async () => {
    fetchRemotePlainChangesMock.mockResolvedValue([]);
    return { deleted: 0 };
  });
  fetchRemoteEncryptedChangesMock.mockClear();
  fetchRemoteEncryptedChangesMock.mockResolvedValue([]);
  fetchRemotePlainChangesMock.mockClear();
  fetchRemotePlainChangesMock.mockResolvedValue([]);
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
  vi.mocked(startFreshSync).mockReset();
  vi.mocked(startFreshSync).mockResolvedValue(undefined);
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
  it('preserves copy-before-delete through the lifecycle seam', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    pushEncryptedChangesMock.mockResolvedValueOnce({ pushed: 2 });
    const lifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
      productionE2EETransitionExecutor,
    );

    const result = await lifecycle.enable('hunter2') as { completed: boolean };

    expect(result.completed).toBe(true);
    expect(pushEncryptedChangesMock).toHaveBeenCalled();
    expect(deleteRemotePlainChangesMock).toHaveBeenCalled();
    expect(pushEncryptedChangesMock.mock.invocationCallOrder[0])
      .toBeLessThan(deleteRemotePlainChangesMock.mock.invocationCallOrder[0]);
    expect(lifecycle.getSnapshot()).toMatchObject({ syncMode: 'e2ee' });
  });

  it('offers the durable recovery code before converting records', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    const events: string[] = [];
    pullSnapshotForMigrationMock.mockImplementationOnce(async () => {
      events.push('convert');
      return { fetched: 0, applied: 0 };
    });

    await startE2EEMigration('hunter2', {
      onRecoveryCode: (code) => events.push(`code:${code}`),
    });

    expect(events).toEqual(['code:TEST-RECO-CODE-2026', 'convert']);
  });

  it('mints a DEK + recovery code, wraps both, and persists the bundle locally and remotely', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    pushEncryptedChangesMock.mockResolvedValueOnce({ pushed: 2 });

    const result = await startE2EEMigration('hunter2');

    expect(generateDek).toHaveBeenCalledTimes(1);
    expect(generateRecoveryCode).toHaveBeenCalledTimes(1);
    expect(derivePassphraseKek).toHaveBeenCalledWith('hunter2', expect.any(String), 600000);
    expect(deriveRecoveryKek).toHaveBeenCalledWith('TEST-RECO-CODE-2026', expect.any(String), 600000);
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
    expect(aggregates).toEqual(new Set(['entry', 'entry', 'profile']));
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
    // The claim is atomic now: begin_sync_transition opens the migration, and
    // complete_sync_transition (guarded by ownership) lands the steady-state.
    expect(state.beginTransitionCalls[0]?.to).toBe('migrating_to_e2ee');
    expect(state.completeTransitionCalls.at(-1)?.to).toBe('e2ee');
  });

  it('pulls a remote snapshot under the DEK before re-encrypting', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('pw');
    // The snapshot pull absorbs server-only rows so the plaintext teardown
    // below can't lose data. It must run under the minted DEK.
    expect(pullSnapshotForMigrationMock).toHaveBeenCalledWith('DEK_BYTES');
  });

  it('encrypts remote tombstones so plaintext deletion can complete safely', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    fetchRemotePlainChangesMock.mockResolvedValueOnce([{
      id: 'entry:deleted-remote', aggregate: 'entry', op: 'delete', payload: null,
      protocolVersion: 1, schemaVersion: 3, createdAt: '2026-05-08T00:00:00.000Z',
    }]);

    const result = await startE2EEMigration('pw');
    const tombstone = await db.migrationBackfill.get('entry:deleted-remote');

    expect(result.completed).toBe(true);
    expect(tombstone).toMatchObject({ op: 'delete', createdAt: '2026-05-08T00:00:00.000Z' });
    expect(tombstone?.payloadCiphertext).toContain('"op":"delete"');
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

  it('retains the source when destination verification fails through the lifecycle seam', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    state.destinationVerificationError = new Error('Destination integrity verification failed');
    const lifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
      productionE2EETransitionExecutor,
    );

    const result = await lifecycle.enable('pw') as { completed: boolean; error?: string };

    expect(result).toMatchObject({
      completed: false,
      error: 'Destination integrity verification failed',
    });
    expect(deleteRemotePlainChangesMock).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toMatchObject({
      syncMode: 'migrating_to_e2ee',
      errorClassification: 'integrity',
    });
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

describe('startE2EEMigration — refuses while a migration is in progress', () => {
  // The enable toggle must not start a fresh migration (a new DEK) on top of an
  // unfinished one — that's what orphaned rows under a second DEK. Resuming is a
  // separate path (resumeE2EEMigration), driven by the migration modal.
  it('throws instead of minting a second DEK', async () => {
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

    await expect(startE2EEMigration('pw')).rejects.toThrow(/already in progress|finish or reset/i);
    expect(generateDek).not.toHaveBeenCalled();
  });
});

describe('cross-device mutual exclusion (begin_sync_transition conflict)', () => {
  it('enable aborts — no DEK minted — when another device already claimed the transition', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    vi.mocked(beginSyncTransition).mockRejectedValueOnce(
      new Error('Another device is already changing encryption settings.'),
    );

    await expect(startE2EEMigration('pw')).rejects.toThrow(/another device/i);
    expect(generateDek).not.toHaveBeenCalled();
  });

  it('disable aborts when another device already claimed the transition', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundleFor('pw');
    vi.mocked(beginSyncTransition).mockRejectedValueOnce(
      new Error('Another device is already changing encryption settings.'),
    );

    await expect(startE2EEDisableMigration('pw')).rejects.toThrow(/another device/i);
    expect(pushPlainChangesMock).not.toHaveBeenCalled();
  });
});

describe('resumeE2EEMigration — resume an in-progress enable', () => {
  it('unwraps the existing bundle and finishes, without minting a new DEK', async () => {
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

    const result = await resumeE2EEMigration('pw');

    // A resume must not mint a fresh DEK or code — that would orphan the
    // already-encrypted backfill rows.
    expect(generateDek).not.toHaveBeenCalled();
    expect(generateRecoveryCode).not.toHaveBeenCalled();
    expect(saveLocalWrappedKeys).not.toHaveBeenCalled();
    expect(result.completed).toBe(true);
    expect(result.syncMode).toBe('e2ee');
    expect(result.recoveryCode).toBeUndefined();
  });

  it('pauses with a clear error when no local bundle exists to unwrap', async () => {
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

    const result = await resumeE2EEMigration('pw');
    // Failure surfaces as a paused migration with the error captured.
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/wrapped (encryption key|key bundle)/i);
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
        id: 'entry:w99',
        aggregate: 'entry',
        op: 'upsert',
        ciphertext: 'ct:{"aggregate":"entry","op":"upsert","record":{"id":"w99"}}',
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
    expect(eventsArg[0].aggregate).toBe('entry');
  });

  it('decrypts only the active DEK version (skips orphan-version rows that would crash the decrypt)', async () => {
    // Bundle the device holds is version 2 (e.g. after a rotation); the disable
    // backfill must request only v2 rows, not every row regardless of version.
    state.localBundle = { ...bundleFor('pw'), dekVersion: 2 };
    fetchRemoteEncryptedChangesMock.mockResolvedValueOnce([]);
    pushPlainChangesMock.mockResolvedValueOnce({ pushed: 3 });

    await startE2EEDisableMigration('pw');

    expect(fetchRemoteEncryptedChangesMock).toHaveBeenCalledWith(2);
    // And it sweeps ALL encrypted rows at the end (no id list) so orphan-version
    // rows the decrypt skipped don't linger on the server.
    expect(deleteRemoteEncryptedChangesMock).toHaveBeenCalledWith();
  });

  it.each([
    {
      name: 'payload identity',
      row: {
        id: 'entry:source-id',
        ciphertext: 'ct:{"aggregate":"entry","op":"upsert","record":{"id":"payload-id"}}',
        encryptionVersion: 1,
      },
    },
    {
      name: 'encryption version',
      row: {
        id: 'entry:w99',
        ciphertext: 'ct:{"aggregate":"entry","op":"upsert","record":{"id":"w99"}}',
        encryptionVersion: 999,
      },
    },
  ])('preserves encrypted sources when $name validation fails', async ({ row }) => {
    fetchRemoteEncryptedChangesMock.mockResolvedValueOnce([{
      ...row,
      iv: 'iv',
      protocolVersion: 1,
      schemaVersion: 3,
      createdAt: '2026-05-01T00:00:00.000Z',
    }]);

    const result = await startE2EEDisableMigration('pw');

    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/rejected/i);
    expect(deleteRemoteEncryptedChangesMock).not.toHaveBeenCalled();
  });

  it('folds rows already in the plaintext table into the conversion set (handles both tables)', async () => {
    fetchRemoteEncryptedChangesMock.mockResolvedValueOnce([
      {
        id: 'entry:w99',
        ciphertext:
          'ct:{"aggregate":"entry","op":"upsert","record":{"id":"w99","updatedAt":"2026-04-01T00:00:00.000Z"}}',
        iv: 'iv',
        protocolVersion: 1,
        encryptionVersion: 1,
        schemaVersion: 1,
        createdAt: '2026-04-01T00:00:00.000Z',
      },
    ]);
    // A row a device pushed to the plaintext table before it learned the disable
    // was underway (RLS lets plain writes through in migrating_to_plain).
    fetchRemotePlainChangesMock.mockResolvedValueOnce([
      {
        id: 'entry:i50',
        aggregate: 'entry',
        op: 'upsert',
        payload: { id: 'i50' },
        protocolVersion: 1,
        schemaVersion: 1,
        createdAt: '2026-05-09T00:00:00.000Z',
      },
    ]);
    pushPlainChangesMock.mockResolvedValueOnce({ pushed: 2 });

    await startE2EEDisableMigration('pw');

    const pushed = pushPlainChangesMock.mock.calls[0]?.[0] as Array<{ id: string }>;
    const ids = pushed.map((c) => c.id);
    expect(ids).toContain('entry:w99'); // converted from the encrypted table
    expect(ids).toContain('entry:i50'); // preserved from the plaintext table
  });

  it('emits canonical `${aggregate}:${entityId}` ids and the record as payload (so pullPlain can read it back)', async () => {
    // Regression for the disable→re-enable crash: plain rows must carry the
    // entity's canonical id and the bare record (pushPlainChanges wraps it in
    // the envelope). The old code used `${migrationId}:plain:...` ids and a
    // shape that pullPlain decoded to a null record.
    fetchRemoteEncryptedChangesMock.mockResolvedValueOnce([
      {
        id: 'mig-abc:entry:w99',
        aggregate: 'entry',
        op: 'upsert',
        ciphertext:
          'ct:{"aggregate":"entry","op":"upsert","record":{"id":"w99","weightLbs":180,"updatedAt":"2026-04-02T00:00:00.000Z"}}',
        iv: 'iv',
        protocolVersion: 1,
        encryptionVersion: 1,
        schemaVersion: 2,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    pushPlainChangesMock.mockResolvedValueOnce({ pushed: 1 });
    deleteRemoteEncryptedChangesMock.mockResolvedValueOnce({ deleted: 1 });

    await startE2EEDisableMigration('pw');

    const change = (pushPlainChangesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0];
    expect(change.id).toBe('entry:w99'); // canonical, not migrationId-prefixed
    expect(change.aggregate).toBe('entry');
    expect(change.op).toBe('upsert');
    expect(change.payload).toMatchObject({ id: 'w99', weightLbs: 180 }); // raw record
    expect(change.createdAt).toBe('2026-04-02T00:00:00.000Z'); // the record's own LWW clock
  });

  it('builds canonical ids from local records on the fallback path', async () => {
    fetchRemoteEncryptedChangesMock.mockResolvedValueOnce([]);
    pushPlainChangesMock.mockResolvedValueOnce({ pushed: 3 });

    await startE2EEDisableMigration('pw');

    const changes = pushPlainChangesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    const ids = changes.map((c) => c.id);
    // Health Entries w1/i1 plus profile come from the storage mock.
    expect(ids).toContain('entry:w1');
    expect(ids).toContain('entry:i1');
    expect(ids).toContain('profile:profile');
    expect(ids.every((id) => !String(id).includes(':plain:'))).toBe(true);
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

  it('cleans up only after authoritative finalization through the lifecycle seam', async () => {
    const lifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
      productionE2EETransitionExecutor,
    );

    await lifecycle.disable('pw');

    expect(clearLocalWrappedKeys).toHaveBeenCalled();
    expect(deleteRemoteWrappedKeys).not.toHaveBeenCalled();
    expect(state.completeTransitionCalls.at(-1)?.to).toBe('plain');
    expect(vi.mocked(completeSyncTransition).mock.invocationCallOrder.at(-1))
      .toBeLessThan(vi.mocked(clearLocalWrappedKeys).mock.invocationCallOrder.at(-1)!);
    expect(clearSession).toHaveBeenCalled();
    const finalSave = state.saveProfileCalls[state.saveProfileCalls.length - 1];
    expect(finalSave).toMatchObject({ passphraseEnabled: false, syncMode: 'plain' });
    expect(lifecycle.getSnapshot()).toMatchObject({
      syncMode: 'plain',
      allowedActions: ['enable'],
    });
  });

  it('retains recovery material when authoritative finalization fails through the lifecycle seam', async () => {
    vi.mocked(completeSyncTransition).mockRejectedValueOnce(
      new Error('Authoritative finalization failed'),
    );
    const lifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
      productionE2EETransitionExecutor,
    );

    const result = await lifecycle.disable('pw') as { completed: boolean; error?: string };

    expect(result).toMatchObject({ completed: false, error: 'Authoritative finalization failed' });
    expect(clearLocalWrappedKeys).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toMatchObject({
      syncMode: 'migrating_to_plain',
      allowedActions: expect.arrayContaining(['resume']),
    });
  });

  it('clears local encrypted + migrationBackfill tables on success', async () => {
    await db.migrationBackfill.put({
      id: 'entry:w99',
      aggregate: 'entry',
      op: 'upsert',
      payloadCiphertext: 'ct:{"aggregate":"entry","op":"upsert","record":{"id":"w99"}}',
      payloadIv: 'iv',
      protocolVersion: 1,
      encryptionVersion: 1,
      schemaVersion: 1,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    await db.encrypted.put({
      id: 'entry:w99',
      entity: 'entry',
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

    const lifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
      productionE2EETransitionExecutor,
    );
    const outcome = await lifecycle.reconcile();

    expect(outcome.status).toBe('paused');
    expect(outcome).toMatchObject({ result: { completed: false, error: 'network down' } });
    expect(lifecycle.getSnapshot()).toMatchObject({
      syncMode: 'migrating_to_e2ee',
      errorClassification: 'network',
    });
  });

  it('reports superseded (not paused) when another device takes the enable over mid-run', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: ownedMigration('enable'),
    } as ProfileSettings;
    state.localBundle = bundleFor('pw');
    vi.mocked(getSessionKey).mockReturnValue('DEK_BYTES');
    // The ownership re-check before the destructive finalize sees a different
    // owner on the server: this device was taken over while it was driving.
    vi.mocked(fetchRemoteSyncAccount).mockResolvedValueOnce({
      syncMode: 'migrating_to_e2ee',
      migration: { ...ownedMigration('enable'), ownerDeviceId: 'device-2' },
      activeDekVersion: 1,
      pendingDekVersion: undefined,
    });

    const lifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
      productionE2EETransitionExecutor,
    );
    const outcome = await lifecycle.reconcile();

    // A clean hand-off, not a failure: the orchestrator must NOT surface an error.
    expect(outcome.status).toBe('superseded');
    // The guarded finalize and the irreversible plaintext delete never ran, so
    // the new owner can finish from intact server state.
    expect(state.completeTransitionCalls).toHaveLength(0);
    expect(deleteRemotePlainChangesMock).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toMatchObject({ syncMode: 'migrating_to_e2ee' });
  });

  it('reports superseded when the guarded finalize loses the disable race', async () => {
    state.mockProfile = {
      id: 'profile',
      syncMode: 'migrating_to_plain',
      e2eeMigration: ownedMigration('disable'),
    } as ProfileSettings;
    state.localBundle = bundleFor('pw');
    vi.mocked(getSessionKey).mockReturnValue('DEK_BYTES');
    // `complete_sync_transition` rejects because the row no longer names us as
    // the owner (a second device finalized first).
    vi.mocked(completeSyncTransition).mockRejectedValueOnce(new MigrationSupersededError());

    const outcome = await autoResumeMigration();

    expect(outcome.status).toBe('superseded');
    // The encrypted copy must survive (we never reached the clear) — the data is
    // already safe as plaintext, and the winning owner owns the teardown.
    expect(state.clearLocalCalls).toBe(0);
  });
});

describe('autoResumeMigration — stands down while a run owns the transition in-tab', () => {
  it('reports in-progress (not needs-passphrase) while a migration run is mid-flight here', async () => {
    // Regression: a run kicked off in this tab flips the profile to a migrating
    // mode; an interleaved autoResumeMigration must not independently raise a
    // resume prompt (which briefly flashed the rotation passphrase modal as the
    // rotation finished). We gate the run's push so it stays mid-flight, then
    // assert autoResumeMigration short-circuits to 'in-progress'.
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
    vi.mocked(getSessionKey).mockReturnValue('DEK_BYTES');

    let releasePush: (() => void) | undefined;
    pushEncryptedChangesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        releasePush = () => resolve({ pushed: 0 });
      }),
    );

    expect(isMigrationRunInProgress()).toBe(false);
    const run = resumeE2EEMigration('pw');
    // Let the run advance to the gated push.
    await Promise.resolve();
    await Promise.resolve();

    expect(isMigrationRunInProgress()).toBe(true);
    expect(await autoResumeMigration()).toEqual({ status: 'in-progress' });

    releasePush?.();
    await run;
    // Guard releases once the run settles, so the next cycle can reconcile.
    expect(isMigrationRunInProgress()).toBe(false);
  });
});

describe('resetEncryptionToPlain — stuck-migration escape hatch', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'migrating_to_e2ee' } as ProfileSettings;
  });

  it('re-pushes local data as canonical plaintext without decrypting anything', async () => {
    pushPlainChangesMock.mockResolvedValueOnce({ pushed: 3 });
    const result = await resetEncryptionToPlain();

    // Reads ciphertext metadata to prove destination completeness, never
    // decrypts it, then verifies the source is empty after the sweep.
    expect(fetchRemoteEncryptedChangesMock).toHaveBeenCalledTimes(2);
    expect(fetchRemoteEncryptedChangesMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteRemoteEncryptedChangesMock.mock.invocationCallOrder[0],
    );
    expect(deleteRemoteEncryptedChangesMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchRemoteEncryptedChangesMock.mock.invocationCallOrder[1],
    );
    const changes = pushPlainChangesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    const ids = changes.map((c) => c.id);
    expect(ids).toContain('entry:w1');
    expect(ids).toContain('entry:i1');
    expect(result.pushed).toBe(3);
  });

  it('discards the encrypted server copy + key bundle and lands in plain mode', async () => {
    setPullCursor('2026-05-01T00:00:00.000Z');
    await resetEncryptionToPlain();

    expect(deleteRemoteEncryptedChangesMock).toHaveBeenCalled();
    expect(clearLocalWrappedKeys).toHaveBeenCalled();
    expect(deleteRemoteWrappedKeys).not.toHaveBeenCalled();
    expect(clearSession).toHaveBeenCalled();
    expect(getPullCursor()).toBeNull();

    const finalSave = state.saveProfileCalls.at(-1);
    expect(finalSave).toMatchObject({ passphraseEnabled: false, syncMode: 'plain' });
    // Routed through the gated transition now: claim migrating_to_plain (so RLS
    // permits the plaintext push and other devices are parked), then finalize to
    // plain under the ownership-guarded complete RPC.
    expect(state.beginTransitionCalls.at(-1)?.to).toBe('migrating_to_plain');
    expect(state.completeTransitionCalls.at(-1)?.to).toBe('plain');
  });

  it('does not delete the encrypted copy if the plaintext push fails', async () => {
    pushPlainChangesMock.mockRejectedValueOnce(new Error('network down'));
    await expect(resetEncryptionToPlain()).rejects.toThrow(/network down/);
    expect(deleteRemoteEncryptedChangesMock).not.toHaveBeenCalled();
  });

  it('refuses (and deletes nothing) when this device has no data to keep', async () => {
    vi.mocked(getAllEntries).mockResolvedValueOnce([]);
    // getAllPrescriptions already returns [] in the storage mock.

    await expect(resetEncryptionToPlain()).rejects.toThrow(/no data on this device/i);
    expect(pushPlainChangesMock).not.toHaveBeenCalled();
    expect(deleteRemoteEncryptedChangesMock).not.toHaveBeenCalled();
  });

  it('republishes valid local ciphertext when no plaintext treatment rows remain', async () => {
    vi.mocked(getAllEntries).mockResolvedValueOnce([]);
    vi.mocked(getSessionKey).mockReturnValueOnce('DEK_BYTES');
    await db.encrypted.put({
      id: 'entry:encrypted-only',
      entity: 'entry',
      ciphertext: 'ct:{"aggregate":"entry","op":"upsert","record":{"id":"encrypted-only"}}',
      iv: 'iv',
      keyVersion: 1,
      updatedAt: '2026-05-01T00:00:00.000Z',
    });

    await resetEncryptionToPlain();

    expect(pushPlainChangesMock).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'entry:encrypted-only' }),
    ]));
  });
});

describe('startFreshToPlain — erase and start over (no local data required)', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'migrating_to_e2ee' } as ProfileSettings;
  });

  it('atomically erases cloud sync data and only then clears local recovery material', async () => {
    await startFreshToPlain();

    expect(startFreshSync).toHaveBeenCalledWith({
      migrationId: expect.any(String),
      ownerDeviceId: 'device-1',
    });
    expect(deleteRemoteEncryptedChangesMock).not.toHaveBeenCalled();
    expect(deleteRemotePlainChangesMock).not.toHaveBeenCalled();
    expect(clearLocalWrappedKeys).toHaveBeenCalled();
    expect(deleteRemoteWrappedKeys).not.toHaveBeenCalled();
    expect(clearSession).toHaveBeenCalled();

    const finalSave = state.saveProfileCalls.at(-1);
    expect(finalSave).toMatchObject({ passphraseEnabled: false, syncMode: 'plain' });
    // Gated transition (see resetEncryptionToPlain): claim migrating_to_plain,
    // then let the atomic Start Fresh RPC finalize it.
    expect(state.beginTransitionCalls.at(-1)?.to).toBe('migrating_to_plain');
    expect(state.completeTransitionCalls).toHaveLength(0);
  });

  it('preserves local recovery material when atomic cloud cleanup fails', async () => {
    vi.mocked(startFreshSync).mockRejectedValueOnce(new Error('network down'));

    await expect(startFreshToPlain()).rejects.toThrow(/network down/);

    expect(clearLocalWrappedKeys).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('preserves recovery material on cleanup failure through the lifecycle seam', async () => {
    state.localBundle = bundleFor('pw');
    state.remoteBundle = state.localBundle;
    vi.mocked(startFreshSync).mockRejectedValueOnce(new Error('network down'));
    const lifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
      productionE2EETransitionExecutor,
    );

    await expect(lifecycle.startFresh(true)).rejects.toThrow(/network down/);

    expect(clearLocalWrappedKeys).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toMatchObject({ syncMode: 'migrating_to_plain' });
  });

  it('never pushes local data (it discards rather than keeps)', async () => {
    await startFreshToPlain();
    expect(pushPlainChangesMock).not.toHaveBeenCalled();
  });
});

describe('takeOverMigration', () => {
  it('claims ownership atomically (CAS on the prior owner) and stamps this device locally', async () => {
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

    // Server-side compare-and-swap against the owner this device last observed.
    const claim = state.claimOwnerCalls.at(-1);
    expect(claim).toEqual({
      migrationId: 'mig-x',
      expectedOwnerDeviceId: 'some-other-device',
      newOwnerDeviceId: 'device-1', // the getDeviceId mock
    });
    // Only after the claim succeeds do we stamp local ownership.
    const saved = state.saveProfileCalls.at(-1);
    expect(saved?.e2eeMigration?.ownerDeviceId).toBe('device-1');
    // Take-over never rewrites the mode (it stays mid-migration).
    expect(state.upsertAccountCalls).toHaveLength(0);
  });

  it('does not stamp local ownership when the claim is lost to a competing device', async () => {
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
    vi.mocked(claimMigrationOwner).mockRejectedValueOnce(new SyncTransitionConflictError());

    await expect(takeOverMigration()).rejects.toThrow(SyncTransitionConflictError);
    // The CAS failed, so we must NOT have stamped this device as the owner —
    // otherwise it would go on to drive a migration another device won.
    const saved = state.saveProfileCalls.at(-1);
    expect(saved?.e2eeMigration?.ownerDeviceId ?? 'some-other-device').toBe('some-other-device');
  });

  it('throws when there is no in-progress migration to take over', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    await expect(takeOverMigration()).rejects.toThrow(/no in-progress migration/i);
  });
});

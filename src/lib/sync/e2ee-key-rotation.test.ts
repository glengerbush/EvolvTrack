import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import type {
  E2EEMigrationState,
  ProfileSettings,
  SyncMode,
  WrappedKeyBundle,
} from '$lib/domain/types';

// Rotation is server-side now: it re-encrypts the server's ciphertext from the
// old DEK to a new one, keeping BOTH key bundles on the server until done.
const state = vi.hoisted(() => ({
  mockProfile: undefined as ProfileSettings | undefined,
  saveProfileCalls: [] as Array<Partial<ProfileSettings>>,
  upsertAccountCalls: [] as Array<{
    mode: SyncMode;
    migration?: E2EEMigrationState;
    dekVersions?: { activeDekVersion?: number | null; pendingDekVersion?: number | null };
  }>,
  completeTransitionCalls: [] as Array<{
    migrationId: string;
    ownerDeviceId: string;
    to: SyncMode;
    activeDekVersion: number | null;
  }>,
  heartbeatCalls: [] as E2EEMigrationState[],
  beginTransitionCalls: [] as Array<{ from: SyncMode[]; to: SyncMode }>,
  localBundle: undefined as WrappedKeyBundle | undefined,
  remoteBundles: [] as WrappedKeyBundle[],
  deletedBundleVersions: [] as Array<number | undefined>,
  generatedDekCounter: 0,
  generatedRecoveryCounter: 0,
}));

vi.mock('$lib/domain/health-data-storage', () => ({
  getAllWeights: vi.fn(async () => []),
  getAllInjections: vi.fn(async () => []),
  getAllPrescriptions: vi.fn(async () => []),
  getProfile: vi.fn(async () => state.mockProfile && ({
    ...state.mockProfile,
    id: 'profile',
    createdAt: state.mockProfile.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: state.mockProfile.updatedAt ?? '2026-05-09T00:00:00.000Z',
    passphraseEnabled: state.mockProfile.passphraseEnabled ?? true,
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
  decryptRecord: vi.fn(async (_key: string, ciphertext: string) => JSON.parse(ciphertext.replace(/^ct:/, ''))),
}));

vi.mock('$lib/sync/session-key', () => ({
  setSessionKey: vi.fn(),
  clearSession: vi.fn(),
  getSessionKey: vi.fn(() => null),
}));

vi.mock('$lib/sync/account-state', () => ({
  getDeviceId: vi.fn(() => 'device-1'),
  advanceSyncTransitionPhase: vi.fn(async () => undefined),
  startFreshSync: vi.fn(async () => undefined),
  upsertRemoteSyncAccount: vi.fn(
    async (
      mode: SyncMode,
      migration?: E2EEMigrationState,
      dekVersions?: { activeDekVersion?: number | null; pendingDekVersion?: number | null },
    ) => {
      state.upsertAccountCalls.push({ mode, migration, dekVersions });
    },
  ),
  beginSyncTransition: vi.fn(async (t: { from: SyncMode[]; to: SyncMode; allocateNewDek: boolean }) => {
    state.beginTransitionCalls.push({ from: t.from, to: t.to });
    // Server allocates the next version off the current (old) bundle version.
    const active = state.localBundle?.dekVersion ?? null;
    return {
      activeDekVersion: active,
      pendingDekVersion: t.allocateNewDek ? (active ?? 0) + 1 : null,
    };
  }),
  SyncTransitionConflictError: class extends Error {},
  MigrationSupersededError: class extends Error {},
  heartbeatMigrationProgress: vi.fn(async (migration: E2EEMigrationState) => {
    state.heartbeatCalls.push(migration);
  }),
  completeSyncTransition: vi.fn(
    async (p: {
      migrationId: string;
      ownerDeviceId: string;
      to: SyncMode;
      activeDekVersion: number | null;
    }) => {
      state.completeTransitionCalls.push(p);
      if (p.to === 'e2ee') {
        const removed = state.remoteBundles
          .filter((bundle) => bundle.dekVersion !== p.activeDekVersion)
          .map((bundle) => bundle.dekVersion);
        state.deletedBundleVersions.push(...removed);
        state.remoteBundles = state.remoteBundles
          .filter((bundle) => bundle.dekVersion === p.activeDekVersion);
      }
    },
  ),
  claimMigrationOwner: vi.fn(async () => undefined),
  // Ownership re-check: reflect the current profile's migration (owner === this
  // device on the happy path) so assertStillMigrationOwner passes.
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
    const row: WrappedKeyBundle = { id: 'self', ...bundle };
    state.localBundle = row;
    return row;
  }),
  clearLocalWrappedKeys: vi.fn(async () => {
    state.localBundle = undefined;
  }),
  fetchRemoteWrappedKeys: vi.fn(async (dekVersion?: number) => {
    if (dekVersion !== undefined) return state.remoteBundles.find((b) => b.dekVersion === dekVersion) ?? null;
    return [...state.remoteBundles].sort((a, b) => b.dekVersion - a.dekVersion)[0] ?? null;
  }),
  fetchAllRemoteWrappedKeys: vi.fn(async () =>
    [...state.remoteBundles].sort((a, b) => a.dekVersion - b.dekVersion),
  ),
  upsertRemoteWrappedKeys: vi.fn(async (bundle: WrappedKeyBundle) => {
    state.remoteBundles = state.remoteBundles.filter((b) => b.dekVersion !== bundle.dekVersion);
    state.remoteBundles.push(bundle);
  }),
  deleteRemoteWrappedKeys: vi.fn(async (dekVersion?: number) => {
    state.deletedBundleVersions.push(dekVersion);
    if (dekVersion === undefined) state.remoteBundles = [];
    else state.remoteBundles = state.remoteBundles.filter((b) => b.dekVersion !== dekVersion);
  }),
}));

// The rotation re-encrypts in a convergence loop (re-runs until a pass converts
// nothing, to sweep up stragglers). Model that: the first pass converts 3 rows,
// the mop-up pass finds none. `reEncryptCalls` is reset in beforeEach.
let reEncryptCalls = 0;
const reEncryptServerRowsMock = vi.fn(
  async (..._args: unknown[]): Promise<number> => (reEncryptCalls++ === 0 ? 3 : 0),
);

vi.mock('$lib/sync/sync-engine', () => ({
  reEncryptServerRows: (...args: unknown[]) => reEncryptServerRowsMock(...args),
  pushEncryptedChanges: vi.fn(async () => ({ pushed: 0 })),
  pushPlainChanges: vi.fn(async () => ({ pushed: 0 })),
  deleteRemoteEncryptedChanges: vi.fn(async () => ({ deleted: 0 })),
  deleteRemotePlainChanges: vi.fn(async () => ({ deleted: 0 })),
  fetchRemoteEncryptedChanges: vi.fn(async () => []),
  pullSnapshotForMigration: vi.fn(async () => ({ fetched: 0, applied: 0 })),
}));

vi.mock('$lib/sync/remote-sync-log-transfer', () => ({
  remoteSyncLogTransfer: {
    createProgressReporter: () => async () => undefined,
    heartbeat: vi.fn(async (migration: E2EEMigrationState) => {
      state.heartbeatCalls.push(migration);
    }),
    rotateCiphertext: (...args: unknown[]) => reEncryptServerRowsMock(...args),
    readEncrypted: vi.fn(async () => []),
  },
}));

import { resumeE2EEKeyRotation, startE2EEKeyRotation } from './e2ee-migration';
import { setSessionKey, getSessionKey } from '$lib/sync/session-key';
import { generateDek, generateRecoveryCode } from '$lib/crypto/e2ee';
import { clearPullCursor, getPullCursor, setPullCursor } from '$lib/sync/pull-cursor';

function bundle(passphrase: string, dekToken: string, dekVersion: number): WrappedKeyBundle {
  return {
    id: 'self',
    dekVersion,
    passphraseSaltB64: 'SALT',
    passphraseWrapped: { ciphertext: `wrap(KEK(${passphrase}),${dekToken})`, iv: 'wiv' },
    passphraseIterations: 600_000,
    recoveryStatus: 'confirmed',
    recoverySaltB64: 'SALT',
    recoveryWrapped: { ciphertext: `wrap(RKEK(OLD_CODE),${dekToken})`, iv: 'wiv' },
    recoveryIterations: 600_000,
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

const rotatingProfile = (): ProfileSettings =>
  ({
    id: 'profile',
    syncMode: 'rotating_e2ee_key',
    e2eeMigration: {
      id: 'rot-1',
      direction: 'rotate',
      ownerDeviceId: 'device-1',
      startedAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    },
  }) as ProfileSettings;

beforeEach(() => {
  state.mockProfile = undefined;
  state.saveProfileCalls.length = 0;
  state.upsertAccountCalls.length = 0;
  state.completeTransitionCalls.length = 0;
  state.heartbeatCalls.length = 0;
  state.beginTransitionCalls.length = 0;
  state.localBundle = undefined;
  state.remoteBundles = [];
  state.deletedBundleVersions.length = 0;
  state.generatedDekCounter = 0;
  state.generatedRecoveryCounter = 0;
  reEncryptServerRowsMock.mockClear();
  reEncryptCalls = 0;
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
    state.localBundle = bundle('OLD_PW', 'OLD_DEK', 3);
    state.remoteBundles = [bundle('OLD_PW', 'OLD_DEK', 3)];
  });

  it('mints a new DEK + recovery code wrapped under the new passphrase at the next version', async () => {
    const result = await startE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(generateDek).toHaveBeenCalledTimes(1);
    expect(generateRecoveryCode).toHaveBeenCalledTimes(1);
    expect(result.recoveryCode).toBe('CODE_1');
    expect(result.completed).toBe(true);
    expect(state.localBundle?.dekVersion).toBe(4);
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(NEW_PW),DEK_1)');
  });

  it('keeps both bundles during the rotation, then drops only the old one', async () => {
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    expect(state.deletedBundleVersions).toContain(3); // old version dropped
    expect(state.remoteBundles.map((b) => b.dekVersion)).toEqual([4]); // only new remains
  });

  it('re-encrypts the server rows from the old DEK to the new DEK (not local data)', async () => {
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    // Two calls: the bulk pass (converts 3) then a convergence mop-up that finds
    // nothing and stops the loop.
    expect(reEncryptServerRowsMock).toHaveBeenCalledTimes(2);
    expect(reEncryptServerRowsMock.mock.calls[0][0]).toMatchObject({
      oldDek: 'OLD_DEK',
      oldVersion: 3,
      newDek: 'DEK_1',
      newVersion: 4,
    });
  });

  it('caches the new DEK as the session key', async () => {
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    expect(setSessionKey).toHaveBeenCalledWith('DEK_1');
  });

  it('keeps sweeping until a pass converts nothing, catching rows pushed mid-rotation', async () => {
    // Bulk pass converts 3; a device that hadn't learned of the rotation pushes 1
    // more old-DEK row during the bulk pass; the third pass finds none and stops.
    reEncryptServerRowsMock.mockClear();
    reEncryptServerRowsMock
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(reEncryptServerRowsMock).toHaveBeenCalledTimes(3);
    // The old bundle is dropped only after the sweep converged, so the straggler
    // is on the new version first.
    expect(state.deletedBundleVersions).toContain(3);
  });

  it('records account-state transitions: rotating_e2ee_key then e2ee, with the active version', async () => {
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    // Entry is claimed atomically via begin_sync_transition; the steady-state is
    // landed (guarded by ownership) via complete_sync_transition.
    expect(state.beginTransitionCalls.at(0)?.to).toBe('rotating_e2ee_key');
    const finalize = state.completeTransitionCalls.at(-1);
    expect(finalize?.to).toBe('e2ee');
    // The new bundle is the active version; pending is always cleared on finish.
    expect(finalize?.activeDekVersion).toBe(4);
  });

  it('resets the pull cursor on completion', async () => {
    setPullCursor('2026-05-01T00:00:00.000Z');
    await startE2EEKeyRotation('OLD_PW', 'NEW_PW');
    expect(getPullCursor()).toBeNull();
  });

  it('rejects an incorrect current passphrase before any destructive work', async () => {
    await expect(startE2EEKeyRotation('WRONG', 'NEW_PW')).rejects.toThrow(/OperationError/);
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(OLD_PW),OLD_DEK)');
    expect(generateDek).not.toHaveBeenCalled();
    expect(state.upsertAccountCalls).toHaveLength(0);
    expect(state.saveProfileCalls).toHaveLength(0);
  });
});

describe('startE2EEKeyRotation — panic rotate (same passphrase)', () => {
  it('mints a new DEK + code but keeps the same passphrase wrap', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundle('PW', 'OLD_DEK', 1);
    state.remoteBundles = [bundle('PW', 'OLD_DEK', 1)];

    const result = await startE2EEKeyRotation('PW');

    expect(result.completed).toBe(true);
    expect(result.recoveryCode).toBe('CODE_1');
    expect(state.localBundle?.dekVersion).toBe(2);
    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe('wrap(KEK(PW),DEK_1)');
  });
});

describe('resumeE2EEKeyRotation — crash / new-device with old + new passphrase', () => {
  it('requires a passphrase', async () => {
    await expect(resumeE2EEKeyRotation('')).rejects.toThrow(/passphrase is required/i);
  });

  it('rejects when no rotation is in progress', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    await expect(resumeE2EEKeyRotation('pw')).rejects.toThrow(/No key rotation/i);
  });

  it('derives both DEKs from the two server bundles and finishes, without re-minting', async () => {
    state.mockProfile = rotatingProfile();
    state.remoteBundles = [bundle('OLD_PW', 'OLD_DEK', 3), bundle('NEW_PW', 'NEW_DEK', 4)];

    const result = await resumeE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(result.completed).toBe(true);
    expect(generateDek).not.toHaveBeenCalled();
    expect(reEncryptServerRowsMock.mock.calls[0][0]).toMatchObject({
      oldDek: 'OLD_DEK',
      oldVersion: 3,
      newDek: 'NEW_DEK',
      newVersion: 4,
    });
    expect(state.deletedBundleVersions).toContain(3);
  });

  it('finalizes (no re-encrypt) when only the new bundle remains', async () => {
    state.mockProfile = rotatingProfile();
    state.remoteBundles = [bundle('NEW_PW', 'NEW_DEK', 4)];

    const result = await resumeE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(result.completed).toBe(true);
    expect(reEncryptServerRowsMock).not.toHaveBeenCalled();
    expect(setSessionKey).toHaveBeenCalledWith('NEW_DEK');
  });

  it('pauses (not throws) when a passphrase does not unwrap its bundle', async () => {
    state.mockProfile = rotatingProfile();
    state.remoteBundles = [bundle('OLD_PW', 'OLD_DEK', 3), bundle('NEW_PW', 'NEW_DEK', 4)];

    const result = await resumeE2EEKeyRotation('WRONG_OLD', 'NEW_PW');
    expect(result.completed).toBe(false);
    expect(result.syncMode).toBe('rotating_e2ee_key');
    expect(result.error).toMatch(/OperationError/);
    // Regression (cross-device): a failed resume must NOT blind-write
    // sync_mode/owner via upsertRemoteSyncAccount — that would clobber a device
    // that took the rotation over. It records an owner-scoped heartbeat instead
    // (which no-ops on the server if this device has been superseded).
    expect(state.upsertAccountCalls).toHaveLength(0);
    expect(state.heartbeatCalls.length).toBeGreaterThan(0);
  });
});

describe('startE2EEKeyRotation — failure path', () => {
  beforeEach(() => {
    state.mockProfile = { id: 'profile', syncMode: 'e2ee' } as ProfileSettings;
    state.localBundle = bundle('OLD_PW', 'OLD_DEK', 1);
    state.remoteBundles = [bundle('OLD_PW', 'OLD_DEK', 1)];
  });

  it('writes a paused rotation state if the re-encrypt fails, leaving both bundles', async () => {
    reEncryptServerRowsMock.mockRejectedValueOnce(new Error('network down'));

    const result = await startE2EEKeyRotation('OLD_PW', 'NEW_PW');

    expect(result.completed).toBe(false);
    expect(result.syncMode).toBe('rotating_e2ee_key');
    expect(result.error).toBe('network down');
    // Recovery code surfaces even on a paused rotation so the user has it.
    expect(result.recoveryCode).toBe('CODE_1');
    // Old bundle is NOT dropped on failure — the rotation stays resumable.
    expect(state.deletedBundleVersions).not.toContain(1);
    expect(state.remoteBundles.map((b) => b.dekVersion).sort()).toEqual([1, 2]);
  });
});

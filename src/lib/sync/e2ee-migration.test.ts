import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import type {
  E2EEMigrationState,
  ProfileSettings,
  SyncMode,
} from '$lib/domain/types';

// ── Mutable state used by mocks ───────────────────────────────────────────
// Use vi.hoisted so the state exists before vi.mock factories run (factories
// are hoisted above the imports).
const state = vi.hoisted(() => ({
  mockProfile: undefined as ProfileSettings | undefined,
  saveProfileCalls: [] as Array<Partial<ProfileSettings>>,
  upsertAccountCalls: [] as Array<{ mode: SyncMode; migration?: E2EEMigrationState }>,
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
  initializePassphrase: vi.fn(async () => 'SALT'),
  deriveSessionKey: vi.fn(async () => 'SESSION_KEY'),
  generateRecoveryCodes: vi.fn(() => ['CODE-A', 'CODE-B']),
  encryptRecord: vi.fn(async (_key: string, record: unknown) => ({
    ciphertext: `ct:${JSON.stringify(record)}`,
    iv: 'iv',
  })),
  decryptRecord: vi.fn(async (_key: string, ciphertext: string) => {
    return JSON.parse(ciphertext.replace(/^ct:/, ''));
  }),
  clearPassphraseMaterial: vi.fn(),
}));

vi.mock('$lib/sync/session-key', () => ({
  setSessionKey: vi.fn(),
  clearSession: vi.fn(),
  getSessionKey: vi.fn(() => 'SESSION_KEY'),
}));

vi.mock('$lib/sync/account-state', () => ({
  getDeviceId: vi.fn(() => 'device-1'),
  upsertRemoteSyncAccount: vi.fn(async (mode: SyncMode, migration?: E2EEMigrationState) => {
    state.upsertAccountCalls.push({ mode, migration });
  }),
}));

const pushEncryptedChangesMock = vi.fn(async (..._args: unknown[]) => ({ pushed: 0 }));
const pushPlainChangesMock = vi.fn(async (..._args: unknown[]) => ({ pushed: 0 }));
const deleteRemoteEncryptedChangesMock = vi.fn(async (..._args: unknown[]) => ({ deleted: 0 }));
const fetchRemoteEncryptedChangesMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);

vi.mock('$lib/sync/sync-engine', () => ({
  pushEncryptedChanges: (...args: unknown[]) => pushEncryptedChangesMock(...args),
  pushPlainChanges: (...args: unknown[]) => pushPlainChangesMock(...args),
  deleteRemoteEncryptedChanges: (...args: unknown[]) => deleteRemoteEncryptedChangesMock(...args),
  fetchRemoteEncryptedChanges: (...args: unknown[]) => fetchRemoteEncryptedChangesMock(...args),
}));

// Imports MUST come after vi.mock so the mocks are applied.
import {
  resumeE2EEDisableMigration,
  resumeE2EEMigration,
  startE2EEDisableMigration,
  startE2EEMigration,
} from './e2ee-migration';
import { db } from '$lib/db/schema';
import {
  clearPassphraseMaterial,
  decryptRecord,
  deriveSessionKey,
  encryptRecord,
  generateRecoveryCodes,
  initializePassphrase,
} from '$lib/crypto/e2ee';
import { clearSession, setSessionKey } from '$lib/sync/session-key';
import { clearPullCursor, getPullCursor, setPullCursor } from '$lib/sync/pull-cursor';

beforeEach(() => {
  state.mockProfile = undefined;
  state.saveProfileCalls.length = 0;
  state.upsertAccountCalls.length = 0;
  pushEncryptedChangesMock.mockClear();
  pushEncryptedChangesMock.mockResolvedValue({ pushed: 0 });
  pushPlainChangesMock.mockClear();
  pushPlainChangesMock.mockResolvedValue({ pushed: 0 });
  deleteRemoteEncryptedChangesMock.mockClear();
  deleteRemoteEncryptedChangesMock.mockResolvedValue({ deleted: 0 });
  fetchRemoteEncryptedChangesMock.mockClear();
  fetchRemoteEncryptedChangesMock.mockResolvedValue([]);
  vi.mocked(encryptRecord).mockClear();
  vi.mocked(decryptRecord).mockClear();
  vi.mocked(clearPassphraseMaterial).mockClear();
  vi.mocked(initializePassphrase).mockClear();
  vi.mocked(deriveSessionKey).mockClear();
  vi.mocked(generateRecoveryCodes).mockClear();
  vi.mocked(setSessionKey).mockClear();
  vi.mocked(clearSession).mockClear();
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
});

describe('startE2EEMigration — happy path from plain', () => {
  it('initializes the passphrase, generates recovery codes, and reports completion', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    pushEncryptedChangesMock.mockResolvedValueOnce({ pushed: 2 });

    const result = await startE2EEMigration('hunter2');

    expect(initializePassphrase).toHaveBeenCalledWith('hunter2');
    expect(generateRecoveryCodes).toHaveBeenCalledTimes(1);
    expect(result.syncMode).toBe('e2ee');
    expect(result.completed).toBe(true);
    expect(result.recoveryCodes).toEqual(['CODE-A', 'CODE-B']);
    expect(result.encryptedEventCount).toBeGreaterThan(0);
    expect(result.pushed).toBe(2);
    expect(result.migration.completedAt).toBeTruthy();
  });

  it('encrypts every aggregate (weights + injections + profile) and writes them to db.migrationBackfill', async () => {
    state.mockProfile = { id: 'profile', syncMode: 'plain' } as ProfileSettings;
    await startE2EEMigration('pw');

    // 1 weight + 1 injection + 1 profile = 3.
    expect(vi.mocked(encryptRecord).mock.calls.length).toBe(3);
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
    // A cursor left over from plain-mode sync would be meaningless against
    // sync_changes_encrypted after the switch to e2ee.
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

  it('resumes an in-progress migration when syncMode is already migrating_to_e2ee', async () => {
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

    const result = await startE2EEMigration('pw');
    // initializePassphrase should NOT be called when we're resuming.
    expect(initializePassphrase).not.toHaveBeenCalled();
    expect(result.completed).toBe(true);
    expect(result.syncMode).toBe('e2ee');
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

  it('clears local crypto material and switches profile to plain on success', async () => {
    await startE2EEDisableMigration('pw');
    expect(clearPassphraseMaterial).toHaveBeenCalled();
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
    expect(clearPassphraseMaterial).not.toHaveBeenCalled();
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

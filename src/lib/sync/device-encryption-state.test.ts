import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WrappedKeyBundle } from '$lib/domain/types';

const h = vi.hoisted(() => ({
  bundle: undefined as WrappedKeyBundle | undefined,
  remoteBundle: undefined as WrappedKeyBundle | undefined,
  remoteWrites: [] as WrappedKeyBundle[],
  localWrites: [] as Array<Omit<WrappedKeyBundle, 'id'>>,
  encryptedRows: [] as Array<Record<string, unknown>>,
  profile: { id: 'profile', syncMode: 'e2ee' } as Record<string, unknown>,
  sessionKey: 'DEK' as string | null,
  pullCursor: 'cursor-1' as string | null,
}));

vi.mock('$lib/domain/health-data-storage', () => ({
  getProfile: vi.fn(async () => h.profile),
  getProfileSyncMode: vi.fn((profile: { syncMode?: string }) => profile.syncMode ?? 'plain'),
  setLocalProfileSyncState: vi.fn(async (state: Record<string, unknown>) => {
    h.profile = { ...h.profile, ...state };
  }),
}));

vi.mock('$lib/db/schema', () => ({
  DB_SCHEMA_VERSION: 3,
  db: { encrypted: { toArray: vi.fn(async () => h.encryptedRows) } },
}));

vi.mock('$lib/sync/wrapped-keys', () => ({
  getLocalWrappedKeys: vi.fn(async () => h.bundle),
  fetchRemoteWrappedKeys: vi.fn(async () => h.remoteBundle ?? h.bundle ?? null),
  upsertRemoteWrappedKeys: vi.fn(async (bundle: WrappedKeyBundle) => {
    h.remoteWrites.push(bundle);
    h.bundle = bundle;
  }),
  saveLocalWrappedKeys: vi.fn(async (bundle: Omit<WrappedKeyBundle, 'id'>) => {
    h.localWrites.push(bundle);
    h.bundle = { id: 'self', ...bundle };
    return h.bundle;
  }),
  clearLocalWrappedKeys: vi.fn(async () => { h.bundle = undefined; }),
  fetchAllRemoteWrappedKeys: vi.fn(async () => h.remoteBundle ? [h.remoteBundle] : []),
  deleteRemoteWrappedKeys: vi.fn(async () => undefined),
}));

vi.mock('$lib/sync/session-key', () => ({
  getSessionKey: vi.fn(() => h.sessionKey),
  hasSessionKey: vi.fn(() => h.sessionKey !== null),
  rehydrateSession: vi.fn(async () => true),
  setSessionKey: vi.fn((key: string) => { h.sessionKey = key; }),
  clearSession: vi.fn(() => { h.sessionKey = null; }),
}));

vi.mock('$lib/sync/pull-cursor', () => ({
  getPullCursor: vi.fn(() => h.pullCursor),
  hydratePullCursor: vi.fn(async () => undefined),
  setPullCursor: vi.fn((cursor: string) => { h.pullCursor = cursor; }),
  clearPullCursor: vi.fn(() => { h.pullCursor = null; }),
}));

vi.mock('$lib/sync/account-state', () => ({
  getDeviceId: vi.fn(() => 'device-1'),
  hydrateDeviceId: vi.fn(async () => 'device-1'),
  clearDeviceIdForErasure: vi.fn(),
}));

vi.mock('$lib/crypto/e2ee', () => ({
  ENCRYPTION_FORMAT_VERSION: 1,
  PBKDF2_ITERATIONS: 600_000,
  decryptRecord: vi.fn(),
  derivePassphraseKek: vi.fn(),
  deriveRecoveryKek: vi.fn(),
  generateDek: vi.fn(),
  generateRecoveryCode: vi.fn(),
  generateSaltB64: vi.fn(),
  unwrapDek: vi.fn(),
  wrapDek: vi.fn(),
}));

import { deviceEncryptionState } from './device-encryption-state';
import {
  decryptRecord,
  derivePassphraseKek,
  deriveRecoveryKek,
  generateDek,
  generateRecoveryCode,
  generateSaltB64,
  unwrapDek,
  wrapDek,
} from '$lib/crypto/e2ee';
import { setSessionKey } from '$lib/sync/session-key';
import { clearSession } from '$lib/sync/session-key';
import { clearPullCursor } from '$lib/sync/pull-cursor';
import { clearLocalWrappedKeys } from '$lib/sync/wrapped-keys';

function bundle(status: WrappedKeyBundle['recoveryStatus']): WrappedKeyBundle {
  return {
    id: 'self',
    dekVersion: 2,
    passphraseSaltB64: 'passphrase-salt',
    passphraseWrapped: { ciphertext: 'passphrase-ciphertext', iv: 'passphrase-iv' },
    passphraseIterations: 600_000,
    recoveryStatus: status,
    recoverySaltB64: 'recovery-salt',
    recoveryWrapped: { ciphertext: 'recovery-ciphertext', iv: 'recovery-iv' },
    recoveryIterations: 600_000,
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
}

beforeEach(() => {
  h.bundle = bundle('unconfirmed');
  h.remoteBundle = undefined;
  h.remoteWrites.length = 0;
  h.localWrites.length = 0;
  h.encryptedRows.length = 0;
  h.profile = { id: 'profile', syncMode: 'e2ee' };
  h.sessionKey = 'DEK';
  h.pullCursor = 'cursor-1';
  vi.mocked(setSessionKey).mockClear();
  vi.mocked(generateRecoveryCode).mockReturnValue('NEW-RECOVERY-CODE');
  vi.mocked(generateDek).mockResolvedValue('NEW-DEK');
  vi.mocked(generateSaltB64).mockReturnValue('new-recovery-salt');
  vi.mocked(deriveRecoveryKek).mockResolvedValue('RECOVERY-KEK');
  vi.mocked(derivePassphraseKek).mockResolvedValue('PASSPHRASE-KEK');
  vi.mocked(unwrapDek).mockResolvedValue('UNLOCKED-DEK');
  vi.mocked(wrapDek).mockResolvedValue({ ciphertext: 'new-recovery-ciphertext', iv: 'new-recovery-iv' });
  vi.mocked(decryptRecord).mockReset();
});

describe('device encryption state', () => {
  it('acknowledges the current recovery wrapping without replacing it', async () => {
    await deviceEncryptionState.acknowledgeRecoveryCode();

    expect(h.remoteWrites.at(-1)).toMatchObject({
      recoveryStatus: 'confirmed',
      recoveryWrapped: { ciphertext: 'recovery-ciphertext' },
    });
    expect(h.localWrites.at(-1)).toMatchObject({ recoveryStatus: 'confirmed' });
  });

  it('unlocks through the coherent device-state interface', async () => {
    await deviceEncryptionState.unlock('passphrase');

    expect(derivePassphraseKek).toHaveBeenCalledWith('passphrase', 'passphrase-salt', 600_000);
    expect(setSessionKey).toHaveBeenCalledWith('UNLOCKED-DEK');
  });

  it('opts out by removing recovery wrapping for the current DEK', async () => {
    await deviceEncryptionState.declineRecoveryCode();

    expect(h.remoteWrites.at(-1)).toMatchObject({ recoveryStatus: 'declined' });
    expect(h.remoteWrites.at(-1)?.recoveryWrapped).toBeUndefined();
    expect(h.localWrites.at(-1)?.recoveryWrapped).toBeUndefined();
  });

  it('generates a replacement around the same active DEK without rotation', async () => {
    const code = await deviceEncryptionState.generateRecoveryCode();

    expect(code).toBe('NEW-RECOVERY-CODE');
    expect(wrapDek).toHaveBeenCalledWith('RECOVERY-KEK', 'DEK');
    expect(h.remoteWrites.at(-1)).toMatchObject({
      dekVersion: 2,
      recoveryStatus: 'unconfirmed',
      recoverySaltB64: 'new-recovery-salt',
      recoveryWrapped: { ciphertext: 'new-recovery-ciphertext' },
    });
  });

  it('creates and persists a complete wrapped-key bundle as one capability', async () => {
    const created = await deviceEncryptionState.createWrappedKeyBundle('passphrase', 3);

    expect(created).toMatchObject({ dek: 'NEW-DEK', recoveryCode: 'NEW-RECOVERY-CODE' });
    expect(h.remoteWrites.at(-1)).toMatchObject({ dekVersion: 3, recoveryStatus: 'unconfirmed' });
    expect(h.localWrites.at(-1)).toMatchObject({ dekVersion: 3, recoveryStatus: 'unconfirmed' });
  });

  it('converges another device’s recovery choice into the local snapshot', async () => {
    h.bundle = bundle('confirmed');
    h.remoteBundle = {
      ...bundle('declined'),
      recoverySaltB64: undefined,
      recoveryWrapped: undefined,
      recoveryIterations: undefined,
      updatedAt: '2026-08-06T00:01:00.000Z',
    };

    await expect(deviceEncryptionState.snapshot({ refreshRemote: true })).resolves.toMatchObject({
      recoveryStatus: 'declined',
    });
    expect(h.localWrites.at(-1)).toMatchObject({ recoveryStatus: 'declined' });
  });

  it('counts only valid, unlockable local treatment ciphertext as readable', async () => {
    h.encryptedRows.push(
      { id: 'entry:corrupt', entity: 'entry', ciphertext: 'bad', iv: 'iv', keyVersion: 1, updatedAt: 'now' },
      { id: 'entry:good', entity: 'entry', ciphertext: 'good', iv: 'iv', keyVersion: 1, updatedAt: 'now' },
    );
    vi.mocked(decryptRecord)
      .mockRejectedValueOnce(new Error('bad ciphertext'))
      .mockResolvedValueOnce({
        aggregate: 'entry', op: 'upsert',
        record: {
          id: 'good', date: '2026-08-06',
          createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
        },
      });

    await expect(deviceEncryptionState.hasReadableLocalTreatmentCiphertext()).resolves.toBe(true);

    vi.mocked(decryptRecord).mockRejectedValue(new Error('bad ciphertext'));
    await expect(deviceEncryptionState.hasReadableLocalTreatmentCiphertext()).resolves.toBe(false);
  });

  it('publishes coherent snapshots and clears encryption state when converging to plain', async () => {
    const snapshots: Array<{ syncMode: string; hasSessionKey: boolean }> = [];
    const unsubscribe = deviceEncryptionState.subscribe((snapshot) => snapshots.push(snapshot));

    await deviceEncryptionState.convergeToPlain();
    unsubscribe();

    expect(snapshots.at(-1)).toMatchObject({ syncMode: 'plain', hasSessionKey: false });
    expect(clearSession).toHaveBeenCalled();
    expect(clearPullCursor).toHaveBeenCalled();
  });

  it('clears every account-scoped encryption value on logout', async () => {
    await deviceEncryptionState.revokeForDeviceDataErasure();

    await expect(deviceEncryptionState.snapshot()).resolves.toMatchObject({
      hasSessionKey: false,
      pullCursor: null,
      wrappedKeys: undefined,
    });
  });

  it('revokes memory state even when durable key cleanup fails', async () => {
    vi.mocked(clearLocalWrappedKeys).mockRejectedValueOnce(new Error('blocked'));

    await expect(deviceEncryptionState.revokeForDeviceDataErasure()).resolves.toBeUndefined();

    expect(h.sessionKey).toBeNull();
    expect(h.pullCursor).toBeNull();
  });

  it('drops a stale session and cursor before adopting a newer remote DEK', async () => {
    h.bundle = bundle('confirmed');
    h.remoteBundle = { ...bundle('confirmed'), dekVersion: 3, updatedAt: '2026-08-06T01:00:00.000Z' };

    await expect(deviceEncryptionState.converge({
      syncMode: 'e2ee', migration: undefined, activeDekVersion: 3,
    })).resolves.toMatchObject({ wrappedKeys: { dekVersion: 3 }, hasSessionKey: false, pullCursor: null });
  });

  it('repairs stray key material in plain mode without losing its valid cursor', async () => {
    h.profile = { id: 'profile', syncMode: 'plain' };

    await expect(deviceEncryptionState.hydrate()).resolves.toMatchObject({
      syncMode: 'plain', hasSessionKey: false, wrappedKeys: undefined, pullCursor: 'cursor-1',
    });
  });

  it('adopts a newer transition checkpoint even when its owner is unchanged', async () => {
    h.profile = {
      id: 'profile', syncMode: 'migrating_to_e2ee',
      e2eeMigration: {
        id: 'old-migration', ownerDeviceId: 'device-1', phase: 'preparing',
        startedAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
      },
    };
    await deviceEncryptionState.converge({
      syncMode: 'migrating_to_e2ee',
      migration: {
        id: 'new-migration', ownerDeviceId: 'device-1', phase: 'transferring',
        startedAt: '2026-08-06T00:01:00.000Z', updatedAt: '2026-08-06T00:02:00.000Z',
      },
    });

    expect(h.profile.e2eeMigration).toMatchObject({ id: 'new-migration', phase: 'transferring' });
  });
});

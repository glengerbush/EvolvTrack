import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WrappedKeyBundle } from '$lib/domain/types';

const h = vi.hoisted(() => ({
  bundle: undefined as WrappedKeyBundle | undefined,
  remoteBundle: undefined as WrappedKeyBundle | undefined,
  remoteWrites: [] as WrappedKeyBundle[],
  localWrites: [] as Array<Omit<WrappedKeyBundle, 'id'>>,
  encryptedRows: [] as Array<Record<string, unknown>>,
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
  clearLocalWrappedKeys: vi.fn(async () => undefined),
}));

vi.mock('$lib/sync/session-key', () => ({
  getSessionKey: vi.fn(() => 'DEK'),
  hasSessionKey: vi.fn(() => true),
  rehydrateSession: vi.fn(async () => true),
  setSessionKey: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock('$lib/sync/pull-cursor', () => ({
  getPullCursor: vi.fn(() => null),
  hydratePullCursor: vi.fn(async () => undefined),
  clearPullCursor: vi.fn(),
}));

vi.mock('$lib/sync/account-state', () => ({
  getDeviceId: vi.fn(() => 'device-1'),
  hydrateDeviceId: vi.fn(async () => 'device-1'),
}));

vi.mock('$lib/crypto/e2ee', () => ({
  ENCRYPTION_FORMAT_VERSION: 1,
  PBKDF2_ITERATIONS: 600_000,
  decryptRecord: vi.fn(),
  derivePassphraseKek: vi.fn(),
  deriveRecoveryKek: vi.fn(),
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
  generateRecoveryCode,
  generateSaltB64,
  unwrapDek,
  wrapDek,
} from '$lib/crypto/e2ee';
import { setSessionKey } from '$lib/sync/session-key';

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
  vi.mocked(setSessionKey).mockClear();
  vi.mocked(generateRecoveryCode).mockReturnValue('NEW-RECOVERY-CODE');
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
      .mockResolvedValueOnce({ aggregate: 'entry', op: 'upsert', record: { id: 'good' } });

    await expect(deviceEncryptionState.hasReadableLocalTreatmentCiphertext()).resolves.toBe(true);

    vi.mocked(decryptRecord).mockRejectedValue(new Error('bad ciphertext'));
    await expect(deviceEncryptionState.hasReadableLocalTreatmentCiphertext()).resolves.toBe(false);
  });
});

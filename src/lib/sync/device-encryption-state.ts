import type { RecoveryCodeStatus, WrappedKeyBundle } from '$lib/domain/types';
import { DB_SCHEMA_VERSION, db, type EncryptedRecord } from '$lib/db/schema';
import { canonicalSyncChange, type PlainSyncChange } from '$lib/sync/canonical-sync-change';
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import { getDeviceId, hydrateDeviceId } from '$lib/sync/account-state';
import {
  clearLocalWrappedKeys,
  fetchRemoteWrappedKeys,
  getLocalWrappedKeys,
  saveLocalWrappedKeys,
  upsertRemoteWrappedKeys,
} from '$lib/sync/wrapped-keys';
import {
  clearSession,
  getSessionKey,
  hasSessionKey,
  rehydrateSession,
  setSessionKey,
} from '$lib/sync/session-key';
import {
  clearPullCursor,
  getPullCursor,
  hydratePullCursor,
} from '$lib/sync/pull-cursor';
import {
  PBKDF2_ITERATIONS,
  decryptRecord,
  derivePassphraseKek,
  deriveRecoveryKek,
  generateRecoveryCode as mintRecoveryCode,
  generateSaltB64,
  unwrapDek,
  wrapDek,
} from '$lib/crypto/e2ee';

async function decodeLocalEncryptedRow(row: EncryptedRecord): Promise<PlainSyncChange> {
  const dek = getSessionKey();
  if (!dek) throw new Error('Local encrypted data is locked.');
  const envelope = await decryptRecord<unknown>(dek, row.ciphertext, row.iv);
  const decoded = canonicalSyncChange.decode({
    sourceId: row.id,
    envelope,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    schemaVersion: DB_SCHEMA_VERSION,
    encryptionVersion: row.keyVersion,
  });
  if (!decoded.accepted) {
    throw new Error(`Local encrypted row ${row.id} was rejected: ${decoded.reason}.`);
  }
  return canonicalSyncChange.fromRecord({
    aggregate: decoded.change.aggregate,
    op: decoded.change.op,
    record: decoded.change.record,
    sourceId: row.id,
    sourceUpdatedAt: row.updatedAt,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    schemaVersion: DB_SCHEMA_VERSION,
    encryptionVersion: row.keyVersion,
  });
}

export type DeviceEncryptionSnapshot = {
  deviceId: string;
  hasSessionKey: boolean;
  pullCursor: string | null;
  wrappedKeys?: WrappedKeyBundle;
  recoveryStatus: RecoveryCodeStatus | 'unavailable';
};

export type DeviceEncryptionStateError = Error & {
  name: 'DeviceEncryptionStateError';
  code: 'missing-key' | 'invalid-passphrase' | 'unavailable';
};

function deviceEncryptionError(
  code: DeviceEncryptionStateError['code'],
  message: string,
): DeviceEncryptionStateError {
  return Object.assign(new Error(message), { name: 'DeviceEncryptionStateError' as const, code });
}

export function isDeviceEncryptionStateError(error: unknown): error is DeviceEncryptionStateError {
  return error instanceof Error && error.name === 'DeviceEncryptionStateError' && 'code' in error;
}

function withoutId(bundle: WrappedKeyBundle): Omit<WrappedKeyBundle, 'id'> {
  const { id: _id, ...rest } = bundle;
  return rest;
}

async function currentBundle(): Promise<WrappedKeyBundle> {
  const local = await getLocalWrappedKeys();
  if (local) return local;
  const remote = await fetchRemoteWrappedKeys();
  const bundle = remote ? await saveLocalWrappedKeys(withoutId(remote)) : undefined;
  if (!bundle) throw new Error('No wrapped encryption key is available.');
  return bundle;
}

async function persistBundle(bundle: WrappedKeyBundle): Promise<void> {
  await upsertRemoteWrappedKeys(bundle);
  await saveLocalWrappedKeys(withoutId(bundle));
}

async function setRecoveryStatus(
  status: Extract<RecoveryCodeStatus, 'confirmed' | 'declined'>,
): Promise<void> {
  const bundle = await currentBundle();
  if (status === 'confirmed' && (!bundle.recoveryWrapped || !bundle.recoverySaltB64)) {
    throw new Error('No recovery code is available to acknowledge.');
  }
  const updated: WrappedKeyBundle = status === 'declined'
    ? {
        ...bundle,
        recoveryStatus: status,
        recoverySaltB64: undefined,
        recoveryWrapped: undefined,
        recoveryIterations: undefined,
        updatedAt: new Date().toISOString(),
      }
    : {
        ...bundle,
        recoveryStatus: status,
        updatedAt: new Date().toISOString(),
      };
  await persistBundle(updated);
}

export const deviceEncryptionState = {
  async hydrate(): Promise<DeviceEncryptionSnapshot> {
    await Promise.all([hydrateDeviceId(), rehydrateSession(), hydratePullCursor()]);
    return this.snapshot();
  },

  async snapshot(options: { refreshRemote?: boolean } = {}): Promise<DeviceEncryptionSnapshot> {
    let wrappedKeys = await getLocalWrappedKeys();
    if (options.refreshRemote) {
      try {
        const remote = await fetchRemoteWrappedKeys();
        if (remote && (
          !wrappedKeys
          || remote.dekVersion !== wrappedKeys.dekVersion
          || remote.updatedAt !== wrappedKeys.updatedAt
          || remote.recoveryStatus !== wrappedKeys.recoveryStatus
        )) {
          const previousVersion = wrappedKeys?.dekVersion;
          wrappedKeys = await saveLocalWrappedKeys(withoutId(remote));
          if (previousVersion !== undefined && previousVersion !== remote.dekVersion) {
            clearSession();
            clearPullCursor();
          }
        }
      } catch {
        // Offline snapshots remain useful from durable local state.
      }
    }
    return {
      deviceId: getDeviceId(),
      hasSessionKey: hasSessionKey(),
      pullCursor: getPullCursor(),
      wrappedKeys,
      recoveryStatus: wrappedKeys?.recoveryStatus ?? 'unavailable',
    };
  },

  getSessionKey(): string | null {
    return getSessionKey();
  },

  async hasReadableLocalTreatmentCiphertext(): Promise<boolean> {
    if (!getSessionKey()) return false;
    for (const row of await db.encrypted.toArray()) {
      try {
        if ((await decodeLocalEncryptedRow(row)).aggregate !== 'profile') return true;
      } catch {
        // Corrupt or wrong-key ciphertext is not a Recoverable Copy.
      }
    }
    return false;
  },

  async readLocalEncryptedChanges(): Promise<PlainSyncChange[]> {
    return Promise.all((await db.encrypted.toArray()).map(decodeLocalEncryptedRow));
  },

  async unlock(passphrase: string): Promise<void> {
    let bundle: WrappedKeyBundle;
    try {
      bundle = await currentBundle();
    } catch (cause) {
      if ((cause as Error).message === 'No wrapped encryption key is available.') {
        throw deviceEncryptionError('missing-key', (cause as Error).message);
      }
      throw deviceEncryptionError('unavailable', (cause as Error).message);
    }
    const kek = await derivePassphraseKek(
      passphrase,
      bundle.passphraseSaltB64,
      bundle.passphraseIterations,
    );
    let dek: string;
    try {
      dek = await unwrapDek(
        kek,
        bundle.passphraseWrapped.ciphertext,
        bundle.passphraseWrapped.iv,
      );
    } catch {
      throw deviceEncryptionError(
        'invalid-passphrase',
        "That passphrase didn't unlock your encrypted data.",
      );
    }
    setSessionKey(dek);
  },

  acknowledgeRecoveryCode(): Promise<void> {
    return setRecoveryStatus('confirmed');
  },

  declineRecoveryCode(): Promise<void> {
    return setRecoveryStatus('declined');
  },

  async generateRecoveryCode(passphrase?: string): Promise<string> {
    const bundle = await currentBundle();
    let dek = getSessionKey();
    if (!dek) {
      if (!passphrase) throw new Error('Enter your passphrase to generate a recovery code.');
      const passphraseKek = await derivePassphraseKek(
        passphrase,
        bundle.passphraseSaltB64,
        bundle.passphraseIterations,
      );
      dek = await unwrapDek(
        passphraseKek,
        bundle.passphraseWrapped.ciphertext,
        bundle.passphraseWrapped.iv,
      );
    }

    const code = mintRecoveryCode();
    const recoverySaltB64 = generateSaltB64();
    const recoveryKek = await deriveRecoveryKek(code, recoverySaltB64, PBKDF2_ITERATIONS);
    const recoveryWrapped = await wrapDek(recoveryKek, dek);
    await persistBundle({
      ...bundle,
      recoveryStatus: 'unconfirmed',
      recoverySaltB64,
      recoveryWrapped,
      recoveryIterations: PBKDF2_ITERATIONS,
      updatedAt: new Date().toISOString(),
    });
    return code;
  },

  async clearForPlainMode(): Promise<void> {
    await clearLocalWrappedKeys();
    clearSession();
    clearPullCursor();
  },
};

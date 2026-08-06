import type { RecoveryCodeStatus, WrappedKeyBundle } from '$lib/domain/types';
import type { E2EEMigrationState, SyncMode } from '$lib/domain/types';
import { getProfile, getProfileSyncMode, setLocalProfileSyncState } from '$lib/domain/repo';
import { DB_SCHEMA_VERSION, db, type EncryptedRecord } from '$lib/db/schema';
import { canonicalSyncChange, type PlainSyncChange } from '$lib/sync/canonical-sync-change';
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import { getDeviceId, hydrateDeviceId } from '$lib/sync/account-state';
import type { RemoteSyncAccount } from '$lib/sync/account-state';
import {
  clearLocalWrappedKeys,
  deleteRemoteWrappedKeys,
  fetchAllRemoteWrappedKeys,
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
  setPullCursor,
} from '$lib/sync/pull-cursor';
import {
  PBKDF2_ITERATIONS,
  decryptRecord,
  derivePassphraseKek,
  deriveRecoveryKek,
  generateDek,
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
  syncMode: SyncMode;
  migration?: E2EEMigrationState;
  deviceId: string;
  hasSessionKey: boolean;
  pullCursor: string | null;
  wrappedKeys?: WrappedKeyBundle;
  recoveryStatus: RecoveryCodeStatus | 'unavailable';
};

const subscribers = new Set<(snapshot: DeviceEncryptionSnapshot) => void>();
let currentSnapshot: DeviceEncryptionSnapshot = {
  syncMode: 'plain',
  deviceId: '',
  hasSessionKey: false,
  pullCursor: null,
  recoveryStatus: 'unavailable',
};

function publish(snapshot: DeviceEncryptionSnapshot): DeviceEncryptionSnapshot {
  currentSnapshot = snapshot;
  for (const subscriber of subscribers) subscriber(snapshot);
  return snapshot;
}

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
    const hydrated = await this.snapshot();
    if (hydrated.syncMode === 'plain' && (hydrated.hasSessionKey || hydrated.wrappedKeys)) {
      await clearLocalWrappedKeys();
      clearSession();
      return this.snapshot();
    }
    return hydrated;
  },

  async snapshot(options: { refreshRemote?: boolean } = {}): Promise<DeviceEncryptionSnapshot> {
    const profile = await getProfile();
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
    return publish({
      syncMode: getProfileSyncMode(profile),
      migration: profile?.e2eeMigration,
      deviceId: getDeviceId(),
      hasSessionKey: hasSessionKey(),
      pullCursor: getPullCursor(),
      wrappedKeys,
      recoveryStatus: wrappedKeys?.recoveryStatus ?? 'unavailable',
    });
  },

  subscribe(run: (snapshot: DeviceEncryptionSnapshot) => void): () => void {
    subscribers.add(run);
    run(currentSnapshot);
    void this.snapshot();
    return () => subscribers.delete(run);
  },

  getSessionKey(): string | null {
    return getSessionKey();
  },

  activateSessionKey(key: string): void {
    setSessionKey(key);
  },

  async activeDekVersion(): Promise<number> {
    return (await getLocalWrappedKeys())?.dekVersion ?? 1;
  },

  getActiveWrappedKeyBundle(): Promise<WrappedKeyBundle | undefined> {
    return getLocalWrappedKeys();
  },

  requireWrappedKeyBundle(): Promise<WrappedKeyBundle> {
    return currentBundle();
  },

  getRotationKeyBundles(): Promise<WrappedKeyBundle[]> {
    return fetchAllRemoteWrappedKeys();
  },

  cacheActiveWrappedKeyBundle(bundle: Omit<WrappedKeyBundle, 'id'>): Promise<WrappedKeyBundle> {
    return saveLocalWrappedKeys(bundle);
  },

  removeCloudKeyMaterial(dekVersion?: number): Promise<void> {
    return deleteRemoteWrappedKeys(dekVersion);
  },

  async clearForLogout(): Promise<void> {
    // Revoke usable in-memory secrets first. Persistent cleanup can fail when
    // IndexedDB is blocked, but that must never leave this process unlocked.
    clearSession();
    clearPullCursor();
    try {
      await clearLocalWrappedKeys();
    } catch {
      // The logout boot sentinel retries durable cleanup on the next launch.
    }
  },

  getPullCursor(): string | null {
    return getPullCursor();
  },

  setPullCursor(cursor: string): void {
    setPullCursor(cursor);
  },

  resetPullCursorForTableSwitch(): void {
    clearPullCursor();
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

  async createWrappedKeyBundle(passphrase: string, dekVersion: number): Promise<{
    dek: string;
    bundle: WrappedKeyBundle;
    recoveryCode: string;
  }> {
    const dek = await generateDek();
    const passphraseSaltB64 = generateSaltB64();
    const recoverySaltB64 = generateSaltB64();
    const recoveryCode = mintRecoveryCode();
    const passphraseKek = await derivePassphraseKek(passphrase, passphraseSaltB64, PBKDF2_ITERATIONS);
    const recoveryKek = await deriveRecoveryKek(recoveryCode, recoverySaltB64, PBKDF2_ITERATIONS);
    const bundle: WrappedKeyBundle = {
      id: 'self',
      dekVersion,
      passphraseSaltB64,
      passphraseWrapped: await wrapDek(passphraseKek, dek),
      passphraseIterations: PBKDF2_ITERATIONS,
      recoveryStatus: 'unconfirmed',
      recoverySaltB64,
      recoveryWrapped: await wrapDek(recoveryKek, dek),
      recoveryIterations: PBKDF2_ITERATIONS,
      updatedAt: new Date().toISOString(),
    };
    await persistBundle(bundle);
    return { dek, bundle, recoveryCode };
  },

  async unwrapWithPassphrase(passphrase: string, bundle?: WrappedKeyBundle): Promise<string> {
    const selected = bundle ?? await currentBundle();
    const kek = await derivePassphraseKek(
      passphrase,
      selected.passphraseSaltB64,
      selected.passphraseIterations,
    );
    return unwrapDek(kek, selected.passphraseWrapped.ciphertext, selected.passphraseWrapped.iv);
  },

  async clearForPlainMode(): Promise<void> {
    await clearLocalWrappedKeys();
    clearSession();
    clearPullCursor();
  },

  async convergeToPlain(): Promise<DeviceEncryptionSnapshot> {
    await this.clearForPlainMode();
    await setLocalProfileSyncState({
      syncMode: 'plain',
      passphraseEnabled: false,
      e2eeMigration: undefined,
    });
    return this.snapshot();
  },

  async converge(remote: RemoteSyncAccount): Promise<DeviceEncryptionSnapshot> {
    const profile = await getProfile();
    const localMode = getProfileSyncMode(profile);
    const localMigration = profile?.e2eeMigration;

    if (remote.syncMode === 'plain') {
      if (localMode !== 'plain') return this.convergeToPlain();
      if (getSessionKey() || await getLocalWrappedKeys()) {
        await clearLocalWrappedKeys();
        clearSession();
      }
      return this.snapshot();
    }

    if (localMode !== 'plain') {
      if (remote.syncMode === 'e2ee' && remote.activeDekVersion != null) {
        const localBundle = await getLocalWrappedKeys();
        if (localBundle && remote.activeDekVersion > localBundle.dekVersion) {
          await clearLocalWrappedKeys();
          clearSession();
          clearPullCursor();
          return this.snapshot({ refreshRemote: true });
        }
      }

      if (remote.syncMode === 'e2ee' && !remote.migration && (localMode !== 'e2ee' || localMigration)) {
        await setLocalProfileSyncState({
          syncMode: 'e2ee',
          passphraseEnabled: true,
          e2eeMigration: undefined,
        });
        clearPullCursor();
        return this.snapshot({ refreshRemote: true });
      }

      if (
        remote.migration
        && (
          !localMigration
          || remote.migration.id !== localMigration.id
          || remote.migration.ownerDeviceId !== localMigration.ownerDeviceId
          || remote.migration.updatedAt > localMigration.updatedAt
        )
      ) {
        await setLocalProfileSyncState({
          syncMode: remote.syncMode,
          passphraseEnabled: true,
          e2eeMigration: remote.migration,
        });
      }
      return this.snapshot();
    }

    if (!(await getLocalWrappedKeys())) {
      try {
        const remoteBundle = await fetchRemoteWrappedKeys();
        if (remoteBundle) await saveLocalWrappedKeys(withoutId(remoteBundle));
      } catch {
        // The unlock path retries remote key retrieval.
      }
    }
    await setLocalProfileSyncState({
      syncMode: remote.syncMode,
      passphraseEnabled: true,
      e2eeMigration: remote.migration,
    });
    clearPullCursor();
    return this.snapshot();
  },
};

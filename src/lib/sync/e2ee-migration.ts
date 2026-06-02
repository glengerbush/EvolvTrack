import { DB_SCHEMA_VERSION, db, type EncryptedRecord } from '$lib/db/schema';
import { nanoid } from 'nanoid';
import {
  getAllInjections,
  getAllPrescriptions,
  getAllWeights,
  getProfile,
  getProfileSyncMode,
  saveProfile,
} from '$lib/domain/repo';
import type {
  E2EEMigrationDirection,
  E2EEMigrationState,
  MigrationBackfillEntry,
  ProfileSettings,
  SyncAggregate,
  SyncMode,
  WrappedKeyBundle,
} from '$lib/domain/types';
import {
  ENCRYPTION_FORMAT_VERSION,
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
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import { getDeviceId, upsertRemoteSyncAccount } from '$lib/sync/account-state';
import { clearSession, getSessionKey, setSessionKey } from '$lib/sync/session-key';
import { clearPullCursor } from '$lib/sync/pull-cursor';
import {
  deleteRemoteEncryptedChanges,
  deleteRemotePlainChanges,
  fetchRemoteEncryptedChanges,
  pullSnapshotForMigration,
  pushEncryptedChanges,
  pushPlainChanges,
  type EncryptedSyncChange,
  type PlainSyncChange,
} from '$lib/sync/sync-engine';
import {
  clearLocalWrappedKeys,
  deleteRemoteWrappedKeys,
  fetchRemoteWrappedKeys,
  getLocalWrappedKeys,
  saveLocalWrappedKeys,
  upsertRemoteWrappedKeys,
} from '$lib/sync/wrapped-keys';

type BackfillItem = {
  aggregate: SyncAggregate;
  id: string;
  updatedAt: string;
  payload: unknown;
};

/** How often the owning device heartbeats progress to the server during a
 * backfill. Other devices read `migration_updated_at` freshness against this to
 * tell a running migration from a stalled one. */
export const MIGRATION_HEARTBEAT_MS = 2000;
/** No heartbeat for this long ⇒ the owning device is treated as stalled/offline
 * and the take-over affordance is emphasised. Several missed heartbeats. */
export const MIGRATION_STALE_MS = 25000;

/** Reports backfill progress as `(converted, total)`; may be throttled. */
type ProgressReporter = (converted: number, total: number) => Promise<void>;

export type E2EEMigrationRunResult = {
  syncMode: SyncMode;
  migration: E2EEMigrationState;
  /** Present only when a fresh recovery code was issued during this run
   * (initial enable, or any rotation). The caller must show it once; it is
   * never recoverable later. */
  recoveryCode?: string;
  encryptedEventCount: number;
  plaintextEventCount?: number;
  deletedEncryptedEventCount?: number;
  pushed: number;
  completed: boolean;
  error?: string;
};

function nowIso() {
  return new Date().toISOString();
}

/**
 * Build a throttled progress reporter for a backfill. Each tick stamps the
 * latest `recordsConverted`/`recordsTotal` and a fresh `updatedAt` onto the
 * local profile (so this device's own UI shows live progress) and the server
 * (so other devices see progress + a liveness heartbeat). Throttled to one
 * write per `MIGRATION_HEARTBEAT_MS`, but the final (`converted === total`)
 * tick always flushes. The server write is best-effort: a transient network
 * failure must not abort the local, CPU-bound encrypt loop — the push at the
 * end of the migration surfaces a real outage.
 */
function createProgressReporter(mode: SyncMode, base: E2EEMigrationState): ProgressReporter {
  let lastWriteAt = 0;
  let latest = base;
  return async (converted, total) => {
    const done = total > 0 && converted >= total;
    const now = Date.now();
    if (!done && now - lastWriteAt < MIGRATION_HEARTBEAT_MS) return;
    lastWriteAt = now;
    latest = { ...latest, recordsConverted: converted, recordsTotal: total, updatedAt: nowIso() };
    await saveProfile({ e2eeMigration: latest });
    await upsertRemoteSyncAccount(mode, latest).catch(() => undefined);
  };
}

type EncryptedSyncPayload = {
  aggregate?: SyncAggregate;
  op?: 'upsert' | 'delete';
  record?: unknown;
  payload?: unknown;
  migrationId?: string;
};

function createMigration(direction: E2EEMigrationDirection): E2EEMigrationState {
  const timestamp = nowIso();
  return {
    id: typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : nanoid(),
    direction,
    ownerDeviceId: getDeviceId(),
    startedAt: timestamp,
    updatedAt: timestamp,
    plaintextHighWaterMark: timestamp,
  };
}

function profilePayload(profile: ProfileSettings): unknown {
  const {
    e2eeMigration: _e2eeMigration,
    syncMode: _syncMode,
    passphraseEnabled: _passphraseEnabled,
    ...syncableProfile
  } = profile;

  return {
    ...syncableProfile,
    passphraseEnabled: false,
  };
}

async function collectBackfillItems(): Promise<BackfillItem[]> {
  const [weights, injections, prescriptions, profile] = await Promise.all([
    getAllWeights(),
    getAllInjections(),
    getAllPrescriptions(),
    getProfile(),
  ]);

  const items: BackfillItem[] = [
    ...weights.map((record) => ({
      aggregate: 'weight' as const,
      id: record.id,
      updatedAt: record.updatedAt,
      payload: record,
    })),
    ...injections.map((record) => ({
      aggregate: 'injection' as const,
      id: record.id,
      updatedAt: record.updatedAt,
      payload: record,
    })),
    ...prescriptions.map((record) => ({
      aggregate: 'prescription' as const,
      id: record.id,
      updatedAt: record.updatedAt,
      payload: record,
    })),
  ];

  if (profile) {
    items.push({
      aggregate: 'profile',
      id: 'profile',
      updatedAt: profile.updatedAt,
      payload: profilePayload(profile),
    });
  }

  return items;
}

async function backfillEncryptedRecords(
  dek: string,
  migrationId: string,
  onProgress?: ProgressReporter,
): Promise<number> {
  const items = await collectBackfillItems();
  const encryptedRecords: EncryptedRecord[] = [];
  const backfillEntries: MigrationBackfillEntry[] = [];
  const total = items.length;
  let converted = 0;

  // Report a zero-progress tick up front so watchers learn the total (and that
  // work has started) before the first record finishes encrypting.
  if (onProgress) await onProgress(0, total);

  for (const item of items) {
    const encrypted = await encryptRecord(dek, {
      aggregate: item.aggregate,
      op: 'upsert',
      record: item.payload,
      migrationId,
    });

    encryptedRecords.push({
      id: `${item.aggregate}:${item.id}`,
      entity: item.aggregate,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: ENCRYPTION_FORMAT_VERSION,
      updatedAt: item.updatedAt,
    });

    backfillEntries.push({
      id: `${migrationId}:${item.aggregate}:${item.id}`,
      aggregate: item.aggregate,
      op: 'upsert',
      payloadCiphertext: encrypted.ciphertext,
      payloadIv: encrypted.iv,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      encryptionVersion: ENCRYPTION_FORMAT_VERSION,
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: nowIso(),
    });

    converted += 1;
    if (onProgress) await onProgress(converted, total);
  }

  await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
    if (encryptedRecords.length) await db.encrypted.bulkPut(encryptedRecords);
    if (backfillEntries.length) await db.migrationBackfill.bulkPut(backfillEntries);
  });

  return backfillEntries.length;
}

function makePlainChangeId(migrationId: string, sourceId: string) {
  return `${migrationId}:plain:${sourceId}`;
}

async function collectPlainChangesFromLocalRecords(migrationId: string): Promise<PlainSyncChange[]> {
  const items = await collectBackfillItems();
  return items.map((item) => ({
    id: makePlainChangeId(migrationId, `${item.aggregate}:${item.id}`),
    aggregate: item.aggregate,
    op: 'upsert',
    payload: item.payload,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    schemaVersion: DB_SCHEMA_VERSION,
    createdAt: nowIso(),
  }));
}

async function decryptLocalBackfill(dek: string, migrationId: string) {
  const rows = await db.migrationBackfill.orderBy('createdAt').toArray();
  const plainChanges: PlainSyncChange[] = [];

  for (const row of rows) {
    const decrypted = await decryptRecord<EncryptedSyncPayload>(dek, row.payloadCiphertext, row.payloadIv);
    plainChanges.push({
      id: makePlainChangeId(migrationId, row.id),
      aggregate: decrypted.aggregate ?? row.aggregate,
      op: decrypted.op ?? row.op,
      payload: decrypted.record ?? decrypted.payload ?? decrypted,
      protocolVersion: row.protocolVersion,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
    });
  }

  return {
    plainChanges,
    encryptedChangeIds: rows.map((row) => row.id),
  };
}

async function decryptRemoteBackfill(dek: string, migrationId: string) {
  const rows = await fetchRemoteEncryptedChanges();
  const plainChanges: PlainSyncChange[] = [];

  for (const row of rows) {
    const decrypted = await decryptRecord<EncryptedSyncPayload>(dek, row.ciphertext, row.iv);
    // aggregate/op live only in the encrypted envelope now (the server
    // columns were dropped). A row whose envelope lacks them is malformed.
    if (!decrypted.aggregate || !decrypted.op) {
      throw new Error(`Encrypted sync row ${row.id} is missing aggregate/op in its envelope.`);
    }
    plainChanges.push({
      id: makePlainChangeId(migrationId, row.id),
      aggregate: decrypted.aggregate,
      op: decrypted.op,
      payload: decrypted.record ?? decrypted.payload ?? decrypted,
      protocolVersion: row.protocolVersion,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
    });
  }

  return {
    plainChanges,
    encryptedChangeIds: rows.map((row: EncryptedSyncChange) => row.id),
  };
}

/**
 * Create a fresh wrapped-key bundle: random DEK + recovery code, both KEKs
 * derived from the passphrase and code, both wrappings persisted locally
 * and to the server.
 */
async function mintBundle(
  passphrase: string,
  options: { dekVersion: number },
): Promise<{ dek: string; bundle: WrappedKeyBundle; recoveryCode: string }> {
  const dek = await generateDek();
  const passphraseSaltB64 = generateSaltB64();
  const recoverySaltB64 = generateSaltB64();
  const recoveryCode = generateRecoveryCode();

  const passphraseKek = await derivePassphraseKek(passphrase, passphraseSaltB64);
  const recoveryKek = await deriveRecoveryKek(recoveryCode, recoverySaltB64);

  const passphraseWrapped = await wrapDek(passphraseKek, dek);
  const recoveryWrapped = await wrapDek(recoveryKek, dek);

  const bundle = await saveLocalWrappedKeys({
    dekVersion: options.dekVersion,
    passphraseSaltB64,
    passphraseWrapped,
    recoverySaltB64,
    recoveryWrapped,
    updatedAt: nowIso(),
  });
  await upsertRemoteWrappedKeys(bundle);

  return { dek, bundle, recoveryCode };
}

/**
 * Unwrap the DEK from the locally-cached bundle using the supplied passphrase.
 * Used by resume/disable flows where the bundle was minted on a previous run.
 */
async function unwrapDekWithPassphrase(passphrase: string): Promise<string> {
  const bundle = await getLocalWrappedKeys();
  if (!bundle) {
    throw new Error('No wrapped-key bundle is present locally. Start the encryption migration again.');
  }
  const kek = await derivePassphraseKek(passphrase, bundle.passphraseSaltB64);
  return unwrapDek(kek, bundle.passphraseWrapped.ciphertext, bundle.passphraseWrapped.iv);
}

async function finishE2EEMigration(migration: E2EEMigrationState): Promise<E2EEMigrationState> {
  const completedAt = nowIso();
  const completedMigration: E2EEMigrationState = {
    ...migration,
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  };

  // The encrypted copies are on the server (the caller pushed them before
  // calling finish). Now drop the plaintext originals — leaving them would
  // mean "E2EE enabled" still left readable PHI in `sync_changes_plain`. If
  // this throws, the caller's catch keeps us in `migrating_to_e2ee` and the
  // next resume retries (re-deleting already-gone rows is a no-op). On a key
  // rotation there are no plaintext rows, so this is a harmless no-op.
  await deleteRemotePlainChanges();
  await upsertRemoteSyncAccount('e2ee', completedMigration);
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'e2ee',
    e2eeMigration: completedMigration,
  });
  // Steady-state sync now pulls `sync_changes_encrypted` instead of `sync_changes_plain`.
  // The pull cursor tracked the old table's `inserted_at` sequence, so it is
  // meaningless against the new one — reset it and let the next pull refetch.
  clearPullCursor();

  return completedMigration;
}

async function continueE2EEMigration(
  passphrase: string,
  recoveryCode?: string,
): Promise<E2EEMigrationRunResult> {
  const profile = await getProfile();
  if (getProfileSyncMode(profile) !== 'migrating_to_e2ee' || !profile?.e2eeMigration) {
    throw new Error('No E2EE migration is in progress.');
  }

  const migration = profile.e2eeMigration;

  try {
    // Prefer the in-memory DEK if a fresh bundle was just minted in the same
    // call; otherwise unwrap from the locally-cached bundle. Inside the try
    // so a wrong-passphrase / missing-bundle error surfaces as a paused
    // migration rather than a thrown exception the UI has to catch.
    let dek = getSessionKey();
    if (!dek) {
      dek = await unwrapDekWithPassphrase(passphrase);
      setSessionKey(dek);
    }

    // Absorb anything that lives only on the server before we re-encrypt and
    // (in finish) delete the plaintext table. Covers a migration interrupted
    // by a crash/quit: another device may have pushed plaintext rows, or a
    // prior partial run of this migration already pushed encrypted rows, that
    // this device never pulled. Idempotent (LWW), so re-running on resume is
    // safe.
    await pullSnapshotForMigration(dek);

    const report = createProgressReporter('migrating_to_e2ee', migration);
    const encryptedEventCount = await backfillEncryptedRecords(dek, migration.id, report);
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      encryptedEventCount,
      recordsTotal: encryptedEventCount,
      recordsConverted: encryptedEventCount,
      updatedAt: nowIso(),
      lastError: undefined,
    };

    await saveProfile({ e2eeMigration: updatedMigration });
    await upsertRemoteSyncAccount('migrating_to_e2ee', updatedMigration);

    const pushed = await pushEncryptedChanges({ allowMigrating: true });
    const completedMigration = await finishE2EEMigration(updatedMigration);

    return {
      syncMode: 'e2ee',
      migration: completedMigration,
      recoveryCode,
      encryptedEventCount,
      pushed: pushed.pushed,
      completed: true,
    };
  } catch (error) {
    const message = (error as Error).message;
    const failedMigration: E2EEMigrationState = {
      ...migration,
      updatedAt: nowIso(),
      lastError: message,
    };

    await saveProfile({
      passphraseEnabled: true,
      syncMode: 'migrating_to_e2ee',
      e2eeMigration: failedMigration,
    });
    await upsertRemoteSyncAccount('migrating_to_e2ee', failedMigration).catch(() => undefined);

    return {
      syncMode: 'migrating_to_e2ee',
      migration: failedMigration,
      recoveryCode,
      encryptedEventCount: failedMigration.encryptedEventCount ?? 0,
      pushed: 0,
      completed: false,
      error: message,
    };
  }
}

export async function startE2EEMigration(passphrase: string): Promise<E2EEMigrationRunResult> {
  if (!passphrase) throw new Error('Passphrase is required.');

  const profile = await getProfile();
  const syncMode = getProfileSyncMode(profile);

  if (syncMode === 'e2ee') {
    throw new Error('End-to-end encryption is already enabled.');
  }
  if (syncMode === 'rotating_e2ee_key') {
    throw new Error('Finish the current key rotation before re-enabling E2EE.');
  }
  if (syncMode === 'migrating_to_plain') {
    throw new Error('Finish the current encryption migration before re-enabling E2EE.');
  }

  if (syncMode === 'migrating_to_e2ee') {
    return continueE2EEMigration(passphrase);
  }

  // Wipe any residual encrypted state before starting a fresh migration. An
  // interrupted prior session can leave rows in db.migrationBackfill, on
  // sync_changes_encrypted, or a stale bundle in wrappedKeys; all of those
  // were encrypted under a key we no longer have, so reusing them would
  // crash every subsequent sync cycle with an opaque OperationError.
  await db.transaction('rw', db.encrypted, db.migrationBackfill, db.wrappedKeys, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
    await db.wrappedKeys.clear();
  });
  await deleteRemoteEncryptedChanges().catch(() => undefined);
  await deleteRemoteWrappedKeys().catch(() => undefined);

  const migration = createMigration('enable');
  const { dek, recoveryCode } = await mintBundle(passphrase, { dekVersion: 1 });
  setSessionKey(dek);

  await upsertRemoteSyncAccount('migrating_to_e2ee', migration);
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'migrating_to_e2ee',
    e2eeMigration: migration,
  });

  return continueE2EEMigration(passphrase, recoveryCode);
}

export async function resumeE2EEMigration(passphrase: string): Promise<E2EEMigrationRunResult> {
  if (!passphrase) throw new Error('Passphrase is required.');
  return continueE2EEMigration(passphrase);
}

async function finishE2EEDisableMigration(
  migration: E2EEMigrationState,
  plaintextEventCount: number,
  deletedEncryptedEventCount: number,
): Promise<E2EEMigrationState> {
  const completedAt = nowIso();
  const completedMigration: E2EEMigrationState = {
    ...migration,
    updatedAt: completedAt,
    completedAt,
    plaintextEventCount,
    deletedEncryptedEventCount,
    lastError: undefined,
  };

  await upsertRemoteSyncAccount('plain', completedMigration);
  await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
  });
  await clearLocalWrappedKeys();
  await deleteRemoteWrappedKeys().catch(() => undefined);
  clearSession();
  // Steady-state sync now pulls `sync_changes_plain` instead of `sync_changes_encrypted`;
  // the old cursor doesn't apply to the new table's `inserted_at` sequence.
  clearPullCursor();
  await saveProfile({
    passphraseEnabled: false,
    syncMode: 'plain',
    e2eeMigration: completedMigration,
  });

  return completedMigration;
}

async function continueE2EEDisableMigration(passphrase: string): Promise<E2EEMigrationRunResult> {
  const profile = await getProfile();
  if (getProfileSyncMode(profile) !== 'migrating_to_plain' || !profile?.e2eeMigration) {
    throw new Error('No E2EE disable migration is in progress.');
  }

  const migration = profile.e2eeMigration;

  try {
    // Need the DEK to decrypt remote events being converted back to plaintext.
    // Unwrap from the local bundle using the supplied passphrase. Inside the
    // try so wrong-passphrase / missing-bundle errors land in the paused-
    // migration result instead of crashing the caller.
    let dek = getSessionKey();
    if (!dek) {
      dek = await unwrapDekWithPassphrase(passphrase);
      setSessionKey(dek);
    }

    const remoteDecrypted = await decryptRemoteBackfill(dek, migration.id);
    const localDecrypted = remoteDecrypted.plainChanges.length
      ? { plainChanges: [] as PlainSyncChange[], encryptedChangeIds: [] as string[] }
      : await decryptLocalBackfill(dek, migration.id);
    const encryptedChangeIds = remoteDecrypted.encryptedChangeIds.length
      ? remoteDecrypted.encryptedChangeIds
      : localDecrypted.encryptedChangeIds;
    const decryptedPlainChanges = remoteDecrypted.plainChanges.length
      ? remoteDecrypted.plainChanges
      : localDecrypted.plainChanges;
    const plainChanges = decryptedPlainChanges.length
      ? decryptedPlainChanges
      : await collectPlainChangesFromLocalRecords(migration.id);

    const plaintextEventCount = plainChanges.length;
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      plaintextEventCount,
      updatedAt: nowIso(),
      lastError: undefined,
    };

    await saveProfile({ e2eeMigration: updatedMigration });
    await upsertRemoteSyncAccount('migrating_to_plain', updatedMigration);

    const pushed = await pushPlainChanges(plainChanges);
    const deleted = await deleteRemoteEncryptedChanges(
      encryptedChangeIds.length ? encryptedChangeIds : undefined,
    );
    const completedMigration = await finishE2EEDisableMigration(
      updatedMigration,
      plaintextEventCount,
      deleted.deleted,
    );

    return {
      syncMode: 'plain',
      migration: completedMigration,
      encryptedEventCount: encryptedChangeIds.length,
      plaintextEventCount,
      deletedEncryptedEventCount: deleted.deleted,
      pushed: pushed.pushed,
      completed: true,
    };
  } catch (error) {
    const message = (error as Error).message;
    const failedMigration: E2EEMigrationState = {
      ...migration,
      updatedAt: nowIso(),
      lastError: message,
    };

    await saveProfile({
      passphraseEnabled: true,
      syncMode: 'migrating_to_plain',
      e2eeMigration: failedMigration,
    });
    await upsertRemoteSyncAccount('migrating_to_plain', failedMigration).catch(() => undefined);

    return {
      syncMode: 'migrating_to_plain',
      migration: failedMigration,
      encryptedEventCount: failedMigration.encryptedEventCount ?? 0,
      plaintextEventCount: failedMigration.plaintextEventCount,
      deletedEncryptedEventCount: failedMigration.deletedEncryptedEventCount,
      pushed: 0,
      completed: false,
      error: message,
    };
  }
}

export async function startE2EEDisableMigration(passphrase: string): Promise<E2EEMigrationRunResult> {
  if (!passphrase) throw new Error('Passphrase is required.');

  const profile = await getProfile();
  const syncMode = getProfileSyncMode(profile);

  if (syncMode === 'plain') {
    throw new Error('End-to-end encryption is already disabled.');
  }

  if (syncMode === 'migrating_to_plain') {
    return continueE2EEDisableMigration(passphrase);
  }

  if (syncMode === 'rotating_e2ee_key') {
    throw new Error('Finish the current key rotation before disabling E2EE.');
  }

  if (syncMode !== 'e2ee') {
    throw new Error('Finish the current encryption migration before disabling E2EE.');
  }

  const migration = createMigration('disable');
  await upsertRemoteSyncAccount('migrating_to_plain', migration);
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'migrating_to_plain',
    e2eeMigration: migration,
  });

  return continueE2EEDisableMigration(passphrase);
}

export async function resumeE2EEDisableMigration(passphrase: string): Promise<E2EEMigrationRunResult> {
  if (!passphrase) throw new Error('Passphrase is required.');
  return continueE2EEDisableMigration(passphrase);
}

// ── Key rotation ──────────────────────────────────────────────────────────
//
// On every rotation we mint a new DEK and re-encrypt every record under it.
// This is the forward-secrecy property: an attacker who captured the old DEK
// can decrypt past ciphertext they captured, but post-rotation rows are under
// a key they don't have. Triggered by passphrase changes, a "panic rotate"
// settings button, and a successful recovery (in step 5).

async function continueE2EEKeyRotation(
  passphrase: string,
  recoveryCode?: string,
): Promise<E2EEMigrationRunResult> {
  const profile = await getProfile();
  if (getProfileSyncMode(profile) !== 'rotating_e2ee_key' || !profile?.e2eeMigration) {
    throw new Error('No key rotation is in progress.');
  }

  const migration = profile.e2eeMigration;

  try {
    // The new bundle was minted by startE2EEKeyRotation before transitioning
    // into 'rotating_e2ee_key'. On a fresh run the DEK is already cached; on
    // resume we need to unwrap it from the (new) local bundle using the
    // supplied passphrase — which is the passphrase the user just set if
    // this was a change-passphrase rotation.
    let dek = getSessionKey();
    if (!dek) {
      dek = await unwrapDekWithPassphrase(passphrase);
      setSessionKey(dek);
    }

    const report = createProgressReporter('rotating_e2ee_key', migration);
    const encryptedEventCount = await backfillEncryptedRecords(dek, migration.id, report);
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      encryptedEventCount,
      recordsTotal: encryptedEventCount,
      recordsConverted: encryptedEventCount,
      updatedAt: nowIso(),
      lastError: undefined,
    };

    await saveProfile({ e2eeMigration: updatedMigration });
    await upsertRemoteSyncAccount('rotating_e2ee_key', updatedMigration);

    // Delete the old encrypted rows (under the old DEK) before pushing the
    // new ones. After this returns, the server has no data the old DEK could
    // read — that's the forward-secrecy boundary.
    await deleteRemoteEncryptedChanges();
    const pushed = await pushEncryptedChanges({ allowMigrating: true });

    const completedMigration = await finishE2EEMigration(updatedMigration);

    return {
      syncMode: 'e2ee',
      migration: completedMigration,
      recoveryCode,
      encryptedEventCount,
      pushed: pushed.pushed,
      completed: true,
    };
  } catch (error) {
    const message = (error as Error).message;
    const failedMigration: E2EEMigrationState = {
      ...migration,
      updatedAt: nowIso(),
      lastError: message,
    };

    await saveProfile({
      passphraseEnabled: true,
      syncMode: 'rotating_e2ee_key',
      e2eeMigration: failedMigration,
    });
    await upsertRemoteSyncAccount('rotating_e2ee_key', failedMigration).catch(() => undefined);

    return {
      syncMode: 'rotating_e2ee_key',
      migration: failedMigration,
      recoveryCode,
      encryptedEventCount: failedMigration.encryptedEventCount ?? 0,
      pushed: 0,
      completed: false,
      error: message,
    };
  }
}

/**
 * Internal helper: run the rotation given the caller has *already proven*
 * they're authorized (either by entering the current passphrase or by
 * unwrapping the bundle with a recovery code). Mints a fresh DEK + bundle
 * wrapped under `passphraseForNewBundle`, transitions sync mode, and kicks
 * off the re-encrypt + push.
 */
async function startKeyRotationAfterAuth(
  passphraseForNewBundle: string,
): Promise<E2EEMigrationRunResult> {
  const existing = await getLocalWrappedKeys();
  const newDekVersion = (existing?.dekVersion ?? 0) + 1;

  // Wipe the local encrypted cache before re-encrypting under the new DEK.
  // Old rows are useless: we have plaintext in the normal tables.
  await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
  });

  const { dek, recoveryCode } = await mintBundle(passphraseForNewBundle, {
    dekVersion: newDekVersion,
  });
  setSessionKey(dek);

  const migration = createMigration('rotate');
  await upsertRemoteSyncAccount('rotating_e2ee_key', migration);
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'rotating_e2ee_key',
    e2eeMigration: migration,
  });

  return continueE2EEKeyRotation(passphraseForNewBundle, recoveryCode);
}

/**
 * Generate a new DEK and re-encrypt every record under it.
 *
 * `newPassphrase` is optional: when omitted, the new bundle is wrapped under
 * `currentPassphrase` (the "panic rotate" affordance — same passphrase, new
 * DEK, fresh recovery code). When supplied, this is a change-passphrase flow:
 * the new bundle is wrapped under `newPassphrase` and the old one is no
 * longer valid.
 */
export async function startE2EEKeyRotation(
  currentPassphrase: string,
  newPassphrase?: string,
): Promise<E2EEMigrationRunResult> {
  if (!currentPassphrase) throw new Error('Current passphrase is required.');

  const profile = await getProfile();
  const syncMode = getProfileSyncMode(profile);

  if (syncMode === 'rotating_e2ee_key') {
    // Resume an in-progress rotation. The bundle is already saved under the
    // new passphrase, so the resume uses whichever new passphrase the caller
    // set originally — or `currentPassphrase` if it was a panic rotate.
    return continueE2EEKeyRotation(newPassphrase ?? currentPassphrase);
  }

  if (syncMode !== 'e2ee') {
    throw new Error('Key rotation requires E2EE to be enabled.');
  }

  // Proof of possession: only proceed if the supplied passphrase actually
  // unwraps the existing DEK. Without this, anyone with localStorage write
  // access could rotate the DEK and lock out the legitimate user.
  await unwrapDekWithPassphrase(currentPassphrase);

  return startKeyRotationAfterAuth(newPassphrase ?? currentPassphrase);
}

export async function resumeE2EEKeyRotation(passphrase: string): Promise<E2EEMigrationRunResult> {
  if (!passphrase) throw new Error('Passphrase is required.');
  return continueE2EEKeyRotation(passphrase);
}

// ── Recovery via recovery code ───────────────────────────────────────────
//
// The recovery code is the second derivation path to the DEK, distinct from
// the passphrase. Using it implies the user has lost or distrusts the
// passphrase, so this flow always:
//   1. Unwraps the DEK via the recovery KEK (proof of possession).
//   2. Immediately runs a full key rotation under the freshly chosen new
//      passphrase. That invalidates the (assumed-leaked) recovery code AND
//      the (assumed-leaked) old DEK for any future writes — same forward
//      secrecy property as `startE2EEKeyRotation`.
//
// "Recover without rotating" isn't offered: if the user can present the
// recovery code, they're already past the proof-of-possession bar, and we'd
// rather force them to set a fresh passphrase + recovery code than let them
// keep using the compromised ones.

/**
 * Recover access to an encrypted account using the one-shot recovery code.
 * Always rotates: a new DEK is minted, every record re-encrypted, and a
 * fresh recovery code returned in the result.
 *
 * Tries the local bundle first (so same-device "forgot passphrase" works
 * offline); falls back to the server when this device has no local bundle
 * (new-device setup).
 */
export async function recoverWithCode(
  recoveryCode: string,
  newPassphrase: string,
): Promise<E2EEMigrationRunResult> {
  if (!recoveryCode?.trim()) throw new Error('Recovery code is required.');
  if (!newPassphrase) throw new Error('New passphrase is required.');

  let bundle = await getLocalWrappedKeys();
  if (!bundle) {
    const remote = await fetchRemoteWrappedKeys();
    if (!remote) {
      throw new Error('No encrypted account is associated with this user.');
    }
    bundle = remote;
    // Cache the fetched bundle locally so the rotation can reference it.
    // The id is fixed to 'self' by saveLocalWrappedKeys.
    const { id: _id, ...withoutId } = remote;
    await saveLocalWrappedKeys(withoutId);
  }

  // Unwrap the DEK with the recovery KEK. A failure here is the canonical
  // "wrong code" signal — surface it as a clean error rather than a paused
  // migration, since nothing destructive has happened yet.
  const recoveryKek = await deriveRecoveryKek(recoveryCode, bundle.recoverySaltB64);
  let dek: string;
  try {
    dek = await unwrapDek(
      recoveryKek,
      bundle.recoveryWrapped.ciphertext,
      bundle.recoveryWrapped.iv,
    );
  } catch {
    throw new Error("That recovery code didn't unlock your data.");
  }

  // Cache the (old) DEK so the rotation flow's session-key plumbing has
  // something valid in place. It's replaced moments later when mintBundle
  // generates the new DEK.
  setSessionKey(dek);

  // Recovery may be invoked from a syncMode that isn't 'e2ee' (e.g. on a
  // brand-new device where profile.syncMode is undefined / 'plain'). Make
  // sure the profile reflects E2EE so the rotation prelude doesn't reject
  // the run.
  const profile = await getProfile();
  if (getProfileSyncMode(profile) !== 'e2ee') {
    await saveProfile({ passphraseEnabled: true, syncMode: 'e2ee' });
  }

  return startKeyRotationAfterAuth(newPassphrase);
}

// ── Crash recovery ─────────────────────────────────────────────────────────
//
// A migration is a multi-step push that can be interrupted by a crash, a
// backgrounded PWA, or a user quitting a too-slow run. The mode flag is
// persisted up-front, so on the next launch the device is still in a
// `migrating_*` / `rotating_*` state with steady-state sync paused. This is the
// hook the sync orchestrator calls to drive that stuck state to completion.

export type MigrationProgress = {
  /** Records re-encrypted so far / total to convert, when reported. */
  recordsConverted?: number;
  recordsTotal?: number;
  /** The owning device's last heartbeat — freshness reveals a stall. */
  updatedAt?: string;
};

export type AutoResumeResult =
  | { status: 'idle' }
  | ({ status: 'awaiting-takeover'; direction: E2EEMigrationDirection; ownerDeviceId: string } & MigrationProgress)
  | { status: 'needs-passphrase'; direction: E2EEMigrationDirection }
  | { status: 'resumed'; result: E2EEMigrationRunResult }
  | { status: 'paused'; result: E2EEMigrationRunResult };

function directionFor(
  migration: E2EEMigrationState,
  mode: SyncMode,
): E2EEMigrationDirection {
  return (
    migration.direction ??
    (mode === 'migrating_to_plain'
      ? 'disable'
      : mode === 'rotating_e2ee_key'
        ? 'rotate'
        : 'enable')
  );
}

/**
 * Resume an interrupted migration owned by this device, using the cached DEK.
 *
 *  - `idle`             — no migration to resume here (steady state, or a
 *                         migrating device with no migration record yet).
 *  - `awaiting-takeover`— a migration is in progress but owned by *another*
 *                         device. This device can adopt it (see
 *                         `takeOverMigration`) once the user opts in; until
 *                         then it does nothing so two devices don't race.
 *  - `needs-passphrase` — a migration owned by this device is in progress but
 *                         the session is locked (no cached DEK); the UI must
 *                         collect the passphrase and call `resume*`.
 *  - `resumed`          — the migration finished; the device is now in its
 *                         steady-state mode.
 *  - `paused`           — resume attempted but failed (e.g. network); the
 *                         device stays migrating and the next cycle retries.
 */
export async function autoResumeMigration(): Promise<AutoResumeResult> {
  const profile = await getProfile();
  const mode = getProfileSyncMode(profile);
  const migration = profile?.e2eeMigration;

  if (
    mode !== 'migrating_to_e2ee' &&
    mode !== 'migrating_to_plain' &&
    mode !== 'rotating_e2ee_key'
  ) {
    return { status: 'idle' };
  }

  // Nothing local to resume — e.g. a device whose reconcile hasn't populated
  // the migration record yet. It'll pick it up on the next cycle.
  if (!migration) return { status: 'idle' };

  // A migration owned by another device: surface a take-over offer rather than
  // silently driving it, so the user decides which device finishes it.
  if (migration.ownerDeviceId !== getDeviceId()) {
    return {
      status: 'awaiting-takeover',
      direction: directionFor(migration, mode),
      ownerDeviceId: migration.ownerDeviceId,
      recordsConverted: migration.recordsConverted,
      recordsTotal: migration.recordsTotal,
      updatedAt: migration.updatedAt,
    };
  }

  // The DEK is normally still in localStorage after a crash (the session key is
  // persisted), so this resumes silently. When it isn't (logout wiped it, or
  // persistence failed, or this device just took the migration over), ask the
  // UI to collect the passphrase instead.
  if (!getSessionKey()) {
    return { status: 'needs-passphrase', direction: directionFor(migration, mode) };
  }

  // Session key present, so the continue* helpers use the cached DEK and the
  // empty passphrase argument is never consulted.
  const result =
    mode === 'migrating_to_plain'
      ? await continueE2EEDisableMigration('')
      : mode === 'rotating_e2ee_key'
        ? await continueE2EEKeyRotation('')
        : await continueE2EEMigration('');

  return { status: result.completed ? 'resumed' : 'paused', result };
}

/**
 * Claim an in-progress migration for this device. Stamps this device as the
 * owner both locally and on the server, so the next sync cycle's
 * `autoResumeMigration` will drive it (prompting for the passphrase, then
 * pulling both the plaintext and encrypted server rows before re-encrypting
 * the union and finishing).
 *
 * Intended for the "take over on this device" affordance shown when a device
 * logs in to find a migration another device started but never finished.
 */
export async function takeOverMigration(): Promise<void> {
  const profile = await getProfile();
  const mode = getProfileSyncMode(profile);
  const migration = profile?.e2eeMigration;

  if (
    !migration ||
    (mode !== 'migrating_to_e2ee' &&
      mode !== 'migrating_to_plain' &&
      mode !== 'rotating_e2ee_key')
  ) {
    throw new Error('No in-progress migration is available to take over.');
  }

  const claimed: E2EEMigrationState = {
    ...migration,
    ownerDeviceId: getDeviceId(),
    updatedAt: nowIso(),
    lastError: undefined,
  };

  await saveProfile({ e2eeMigration: claimed });
  await upsertRemoteSyncAccount(mode, claimed);
}

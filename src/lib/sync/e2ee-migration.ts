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
import { lastSynced } from '$lib/stores/syncStore';
import { errorMessage } from '$lib/utils/errorMessage';
import { beginSyncTransition, getDeviceId, upsertRemoteSyncAccount } from '$lib/sync/account-state';
import { clearSession, getSessionKey, setSessionKey } from '$lib/sync/session-key';
import { clearPullCursor } from '$lib/sync/pull-cursor';
import {
  deleteRemoteEncryptedChanges,
  deleteRemotePlainChanges,
  fetchRemoteEncryptedChanges,
  pullSnapshotForMigration,
  pushEncryptedChanges,
  pushPlainChanges,
  reEncryptServerRows,
  type EncryptedSyncChange,
  type PlainSyncChange,
} from '$lib/sync/sync-engine';
import {
  clearLocalWrappedKeys,
  deleteRemoteWrappedKeys,
  fetchAllRemoteWrappedKeys,
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
      // Canonical `${aggregate}:${entityId}` — the SAME id steady-state encrypted
      // pushes use — so an enable-backfill row and a later steady-state row for
      // the same entity upsert into ONE server row instead of two. Two rows per
      // entity would otherwise collapse to a duplicate id when disabling and
      // crash the plaintext upsert. (`migrationId` lives inside the ciphertext.)
      id: `${item.aggregate}:${item.id}`,
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

/** The last colon-separated segment of a backfill/encrypted row id — the bare
 * entity id, regardless of whether the source id was `${aggregate}:${entityId}`
 * (steady-state) or `${migrationId}:${aggregate}:${entityId}` (migration). */
function lastIdSegment(id: string): string {
  const idx = id.lastIndexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

/**
 * Build a plaintext sync change in the canonical steady-state shape: id is
 * `${aggregate}:${entityId}` (so `pullPlain`/`entityIdFromRowId` recover the
 * right entity and `onConflict: user_id,id` overwrites the entity's row rather
 * than accumulating a new one per migration), and `createdAt` carries the
 * record's own `updatedAt` as the LWW clock. The record itself is the payload;
 * `pushPlainChanges` wraps it in the `{aggregate, op, record}` envelope.
 */
function canonicalPlainChange(
  aggregate: SyncAggregate,
  op: 'upsert' | 'delete',
  record: unknown,
  fallbackSourceId: string,
  fallbackUpdatedAt: string,
  protocolVersion: number = SYNC_PROTOCOL_VERSION,
  schemaVersion: number = DB_SCHEMA_VERSION,
): PlainSyncChange {
  const rec = record as { id?: string; updatedAt?: string } | null | undefined;
  const entityId = rec?.id ?? lastIdSegment(fallbackSourceId);
  return {
    id: `${aggregate}:${entityId}`,
    aggregate,
    op,
    payload: record,
    protocolVersion,
    schemaVersion,
    createdAt: rec?.updatedAt ?? fallbackUpdatedAt,
  };
}

async function collectPlainChangesFromLocalRecords(): Promise<PlainSyncChange[]> {
  const items = await collectBackfillItems();
  return items.map((item) =>
    canonicalPlainChange(item.aggregate, 'upsert', item.payload, item.id, item.updatedAt),
  );
}

async function decryptLocalBackfill(dek: string) {
  const rows = await db.migrationBackfill.orderBy('createdAt').toArray();
  const plainChanges: PlainSyncChange[] = [];

  for (const row of rows) {
    const decrypted = await decryptRecord<EncryptedSyncPayload>(dek, row.payloadCiphertext, row.payloadIv);
    const aggregate = decrypted.aggregate ?? row.aggregate;
    const op = decrypted.op ?? row.op;
    const record = op === 'delete' ? null : (decrypted.record ?? decrypted.payload ?? decrypted);
    plainChanges.push(
      canonicalPlainChange(aggregate, op, record, row.id, row.createdAt, row.protocolVersion, row.schemaVersion),
    );
  }

  return {
    plainChanges,
    encryptedChangeIds: rows.map((row) => row.id),
  };
}

async function decryptRemoteBackfill(dek: string) {
  const rows = await fetchRemoteEncryptedChanges();
  const plainChanges: PlainSyncChange[] = [];

  for (const row of rows) {
    const decrypted = await decryptRecord<EncryptedSyncPayload>(dek, row.ciphertext, row.iv);
    // aggregate/op live only in the encrypted envelope now (the server
    // columns were dropped). A row whose envelope lacks them is malformed.
    if (!decrypted.aggregate || !decrypted.op) {
      throw new Error(`Encrypted sync row ${row.id} is missing aggregate/op in its envelope.`);
    }
    const record = decrypted.op === 'delete' ? null : (decrypted.record ?? decrypted.payload ?? decrypted);
    plainChanges.push(
      canonicalPlainChange(
        decrypted.aggregate,
        decrypted.op,
        record,
        row.id,
        row.createdAt,
        row.protocolVersion,
        row.schemaVersion,
      ),
    );
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
  // Record the now-active DEK version (the bundle everything was just encrypted
  // under) and clear any pending-rotation marker.
  const activeBundle = await getLocalWrappedKeys();
  await upsertRemoteSyncAccount('e2ee', completedMigration, {
    activeDekVersion: activeBundle?.dekVersion ?? 1,
    pendingDekVersion: null,
  });
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'e2ee',
    e2eeMigration: completedMigration,
  });
  // Steady-state sync now pulls `sync_changes_encrypted` instead of `sync_changes_plain`.
  // The pull cursor tracked the old table's `inserted_at` sequence, so it is
  // meaningless against the new one — reset it and let the next pull refetch.
  clearPullCursor();
  // The whole dataset is now on the server under the new mode — that's a
  // completed sync. Stamp it so "Last synced" reflects a real completion, not a
  // mid-flight push step (which is why the granular push/delete helpers no
  // longer record it).
  lastSynced.record();

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
    const message = errorMessage(error);
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
  // Enabling is only allowed from a clean plaintext state. Any in-progress
  // migration must be finished (resume it) or reset first — starting a fresh
  // enable here would mint a second DEK and orphan the rows already on the
  // server under the first one. This is the invariant: at most one DEK, except
  // transiently during a key rotation.
  if (syncMode === 'migrating_to_e2ee') {
    throw new Error('An encryption setup is already in progress. Finish or reset it before enabling again.');
  }
  if (syncMode === 'rotating_e2ee_key') {
    throw new Error('Finish the current key rotation before re-enabling E2EE.');
  }
  if (syncMode === 'migrating_to_plain') {
    throw new Error('Finish the current encryption migration before re-enabling E2EE.');
  }

  const migration = createMigration('enable');

  // Atomically claim the transition on the server (plain → migrating_to_e2ee)
  // and allocate the new DEK version. This is the authoritative cross-device
  // guard: if another device already moved the account out of plain, this throws
  // and we abort before touching anything. Done BEFORE the wipe below so we never
  // destroy another device's encrypted state on a stale-local race.
  const { pendingDekVersion } = await beginSyncTransition({
    from: ['plain'],
    to: 'migrating_to_e2ee',
    migration,
    allocateNewDek: true,
  });
  const dekVersion = pendingDekVersion ?? 1;

  // Now that we own the transition, wipe any residual encrypted state before
  // minting: rows in db.migrationBackfill, on sync_changes_encrypted, or a stale
  // bundle in wrappedKeys. Do-or-abort (not best-effort) so old-DEK rows can't
  // survive alongside the new key.
  await db.transaction('rw', db.encrypted, db.migrationBackfill, db.wrappedKeys, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
    await db.wrappedKeys.clear();
  });
  try {
    await deleteRemoteEncryptedChanges();
    await deleteRemoteWrappedKeys();
  } catch (cause) {
    throw new Error(
      `Couldn't clear the previous encrypted data before enabling (${errorMessage(cause)}). ` +
        'Check your connection and try again.',
    );
  }

  const { dek, recoveryCode } = await mintBundle(passphrase, { dekVersion });
  setSessionKey(dek);

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

  await upsertRemoteSyncAccount('plain', completedMigration, {
    activeDekVersion: null,
    pendingDekVersion: null,
  });
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
  // A completed disable is a completed sync — see finishE2EEMigration.
  lastSynced.record();

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

    const remoteDecrypted = await decryptRemoteBackfill(dek);
    const localDecrypted = remoteDecrypted.plainChanges.length
      ? { plainChanges: [] as PlainSyncChange[], encryptedChangeIds: [] as string[] }
      : await decryptLocalBackfill(dek);
    const encryptedChangeIds = remoteDecrypted.encryptedChangeIds.length
      ? remoteDecrypted.encryptedChangeIds
      : localDecrypted.encryptedChangeIds;
    const decryptedPlainChanges = remoteDecrypted.plainChanges.length
      ? remoteDecrypted.plainChanges
      : localDecrypted.plainChanges;
    const plainChanges = decryptedPlainChanges.length
      ? decryptedPlainChanges
      : await collectPlainChangesFromLocalRecords();

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
    const message = errorMessage(error);
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
  // Atomically claim e2ee → migrating_to_plain (cross-device mutual exclusion);
  // throws if another device already moved the account.
  await beginSyncTransition({ from: ['e2ee'], to: 'migrating_to_plain', migration, allocateNewDek: false });
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

/** Unwrap a DEK from a specific bundle with a passphrase (forward-secrecy KEK). */
async function deriveDekFromBundle(bundle: WrappedKeyBundle, passphrase: string): Promise<string> {
  const kek = await derivePassphraseKek(passphrase, bundle.passphraseSaltB64);
  return unwrapDek(kek, bundle.passphraseWrapped.ciphertext, bundle.passphraseWrapped.iv);
}

/**
 * Run (or resume) the re-encrypt + finalize half of a rotation, given both
 * DEKs. Returns a completed result, or a paused one if anything fails — which
 * leaves the rotation resumable, because both bundles and the old-version rows
 * are still in place until the very end.
 */
async function driveRotation(
  oldDek: string,
  oldVersion: number,
  newDek: string,
  newVersion: number,
  migration: E2EEMigrationState,
  recoveryCode?: string,
): Promise<E2EEMigrationRunResult> {
  try {
    setSessionKey(newDek);
    const report = createProgressReporter('rotating_e2ee_key', migration);
    const converted = await reEncryptServerRows({ oldDek, oldVersion, newDek, newVersion, onProgress: report });
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      encryptedEventCount: converted,
      recordsTotal: converted,
      recordsConverted: converted,
      updatedAt: nowIso(),
      lastError: undefined,
    };
    await saveProfile({ e2eeMigration: updatedMigration });
    await upsertRemoteSyncAccount('rotating_e2ee_key', updatedMigration, {
      activeDekVersion: oldVersion,
      pendingDekVersion: newVersion,
    });

    // Every row is under the new DEK now → drop the old key bundle. After this
    // the old DEK can read nothing on the server: the forward-secrecy boundary.
    await deleteRemoteWrappedKeys(oldVersion);
    await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
      await db.encrypted.clear();
      await db.migrationBackfill.clear();
    });

    const completedMigration = await finishE2EEMigration(updatedMigration);
    return {
      syncMode: 'e2ee',
      migration: completedMigration,
      recoveryCode,
      encryptedEventCount: converted,
      pushed: converted,
      completed: true,
    };
  } catch (error) {
    const message = errorMessage(error);
    const failedMigration: E2EEMigrationState = { ...migration, updatedAt: nowIso(), lastError: message };
    await saveProfile({ passphraseEnabled: true, syncMode: 'rotating_e2ee_key', e2eeMigration: failedMigration });
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
 * Begin a rotation once the caller has proven possession of the old DEK (the
 * current passphrase unwrapped it, or a recovery code did). Atomically claims
 * the e2ee → rotating transition (cross-device mutual exclusion) and gets the
 * server-allocated old/new DEK versions — so two concurrent rotations can't pick
 * the same version. Mints the new bundle ALONGSIDE the old one, then drives the
 * re-encrypt.
 */
async function beginKeyRotation(
  oldDek: string,
  newPassphrase: string,
): Promise<E2EEMigrationRunResult> {
  const migration = createMigration('rotate');
  const { activeDekVersion, pendingDekVersion } = await beginSyncTransition({
    from: ['e2ee'],
    to: 'rotating_e2ee_key',
    migration,
    allocateNewDek: true,
  });
  const oldVersion = activeDekVersion ?? 1;
  const newVersion = pendingDekVersion ?? oldVersion + 1;
  const { dek: newDek, recoveryCode } = await mintBundle(newPassphrase, { dekVersion: newVersion });
  await saveProfile({ passphraseEnabled: true, syncMode: 'rotating_e2ee_key', e2eeMigration: migration });
  return driveRotation(oldDek, oldVersion, newDek, newVersion, migration, recoveryCode);
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
    // Resume an in-progress rotation under the passphrase(s) supplied.
    return resumeE2EEKeyRotation(currentPassphrase, newPassphrase ?? currentPassphrase);
  }
  if (syncMode !== 'e2ee') {
    throw new Error('Key rotation requires E2EE to be enabled.');
  }

  const oldBundle = await getLocalWrappedKeys();
  if (!oldBundle) {
    throw new Error('No local key bundle is present. Unlock on this device before rotating.');
  }
  // Proof of possession AND the old DEK: only proceed if the supplied passphrase
  // actually unwraps the current bundle.
  const oldDek = await deriveDekFromBundle(oldBundle, currentPassphrase);
  return beginKeyRotation(oldDek, newPassphrase ?? currentPassphrase);
}

/**
 * Resume a rotation — same device after a crash, or a fresh device. Needs the
 * passphrase for each in-flight bundle: `oldPassphrase` unwraps the old bundle
 * (to decrypt rows still under it) and `newPassphrase` unwraps the new one. For
 * a panic rotate they're identical, so `newPassphrase` defaults to `oldPassphrase`.
 */
export async function resumeE2EEKeyRotation(
  oldPassphrase: string,
  newPassphrase?: string,
): Promise<E2EEMigrationRunResult> {
  if (!oldPassphrase) throw new Error('Passphrase is required.');
  const np = newPassphrase ?? oldPassphrase;

  const profile = await getProfile();
  if (getProfileSyncMode(profile) !== 'rotating_e2ee_key' || !profile?.e2eeMigration) {
    throw new Error('No key rotation is in progress.');
  }
  const migration = profile.e2eeMigration;

  let oldDek: string;
  let oldVersion: number;
  let newDek: string;
  let newVersion: number;
  try {
    const bundles = await fetchAllRemoteWrappedKeys(); // ascending by version
    if (bundles.length === 0) throw new Error('No key bundle is associated with this account.');

    const newBundle = bundles[bundles.length - 1];
    newVersion = newBundle.dekVersion;
    newDek = await deriveDekFromBundle(newBundle, np);
    const { id: _id, ...withoutId } = newBundle;
    await saveLocalWrappedKeys(withoutId);

    if (bundles.length === 1) {
      // The old bundle is already gone → the re-encrypt finished on a previous
      // run; just finalize into steady-state e2ee under the new key.
      setSessionKey(newDek);
      const completedMigration = await finishE2EEMigration({ ...migration, updatedAt: nowIso(), lastError: undefined });
      return {
        syncMode: 'e2ee',
        migration: completedMigration,
        encryptedEventCount: migration.encryptedEventCount ?? 0,
        pushed: 0,
        completed: true,
      };
    }

    const oldBundle = bundles[0];
    oldVersion = oldBundle.dekVersion;
    oldDek = await deriveDekFromBundle(oldBundle, oldPassphrase);
  } catch (error) {
    const message = errorMessage(error);
    const failedMigration: E2EEMigrationState = { ...migration, updatedAt: nowIso(), lastError: message };
    await saveProfile({ passphraseEnabled: true, syncMode: 'rotating_e2ee_key', e2eeMigration: failedMigration });
    await upsertRemoteSyncAccount('rotating_e2ee_key', failedMigration).catch(() => undefined);
    return {
      syncMode: 'rotating_e2ee_key',
      migration: failedMigration,
      encryptedEventCount: failedMigration.encryptedEventCount ?? 0,
      pushed: 0,
      completed: false,
      error: message,
    };
  }

  return driveRotation(oldDek, oldVersion, newDek, newVersion, migration);
}

/**
 * Resume whichever migration is in flight, dispatched by direction. The single
 * entry point the migration modal calls so it doesn't have to branch on the
 * three resume functions itself.
 */
export function resumeMigrationByDirection(
  direction: E2EEMigrationDirection,
  passphrase: string,
): Promise<E2EEMigrationRunResult> {
  if (direction === 'disable') return resumeE2EEDisableMigration(passphrase);
  if (direction === 'rotate') return resumeE2EEKeyRotation(passphrase);
  return resumeE2EEMigration(passphrase);
}

export type ResetToPlainResult = { pushed: number };

/**
 * Escape hatch for a migration wedged by a DEK mismatch — i.e. the server holds
 * encrypted rows under a key the current bundle can no longer unwrap (e.g. after
 * cycling E2EE on/off, which mints a fresh DEK each time and orphans the old
 * encrypted rows). The normal disable flow can't help because it tries to
 * *decrypt* those rows and throws.
 *
 * This re-establishes THIS device's local plaintext as the canonical server copy
 * and then discards the undecryptable encrypted state. It never decrypts
 * anything, so it can't get stuck on the bad rows. Local data is untouched.
 *
 * Only safe to run on a device that actually holds the data — the caller must
 * confirm that first (the encrypted server rows are unreadable, so once they're
 * gone there's no other source).
 */
export async function resetEncryptionToPlain(): Promise<ResetToPlainResult> {
  const plainChanges = await collectPlainChangesFromLocalRecords();

  // Refuse if this device has no actual health data to keep (a lone profile row
  // doesn't count). The encrypted server copy is unreadable — that's why we're
  // here — so wiping it without a local copy to re-upload would erase the only
  // remaining data. Recovery must come from a device that still has the data,
  // or from the passphrase / recovery-code flow.
  const dataChanges = plainChanges.filter((c) => c.aggregate !== 'profile');
  if (dataChanges.length === 0) {
    throw new Error(
      'There is no data on this device to keep, so resetting would erase your only copy. ' +
        'Recover with your passphrase or recovery code on a device that has your data instead.',
    );
  }

  // 1. Push this device's records to the plaintext table FIRST, so the data is
  //    safely on the server before anything is deleted. Canonical envelope rows
  //    (see pushPlainChanges), LWW-merged by other devices on their next pull.
  const pushed = await pushPlainChanges(plainChanges);

  // 2. Now drop the encrypted server copy + key bundle (the unreadable rows) and
  //    any local encrypted scratch.
  await deleteRemoteEncryptedChanges();
  await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
  });
  await clearLocalWrappedKeys();
  await deleteRemoteWrappedKeys().catch(() => undefined);
  clearSession();
  // Pull cursor pointed into the encrypted table's sequence; reset for plain.
  clearPullCursor();

  // 3. Land in a clean plaintext state, locally and on the server.
  const completedAt = nowIso();
  const migration: E2EEMigrationState = {
    ...createMigration('disable'),
    startedAt: completedAt,
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  };
  await saveProfile({ passphraseEnabled: false, syncMode: 'plain', e2eeMigration: migration });
  await upsertRemoteSyncAccount('plain', migration, { activeDekVersion: null, pendingDekVersion: null });
  lastSynced.record();

  return { pushed: pushed.pushed };
}

/**
 * Hard reset / "start over": abandon the account's synced data entirely and
 * return to a clean plaintext state. Unlike `resetEncryptionToPlain` this does
 * NOT require (or keep) local data — it's the escape for when every device is
 * empty and the encrypted server copy can't be unlocked, so the only way back
 * into the account is to wipe the wreckage and re-import from a backup file.
 *
 * Deliberately destructive: it deletes the server's encrypted AND plaintext sync
 * rows plus the key bundle. The caller MUST get an explicit, well-informed
 * confirmation first. Local data tables are left untouched (an import replaces
 * them); server deletes are best-effort so the device always lands usable even
 * if one delete fails over a flaky connection.
 */
export async function startFreshToPlain(): Promise<void> {
  await deleteRemoteEncryptedChanges().catch(() => undefined);
  await deleteRemotePlainChanges().catch(() => undefined);
  await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
  });
  await clearLocalWrappedKeys();
  await deleteRemoteWrappedKeys().catch(() => undefined);
  clearSession();
  clearPullCursor();

  const completedAt = nowIso();
  const migration: E2EEMigrationState = {
    ...createMigration('disable'),
    startedAt: completedAt,
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  };
  await saveProfile({ passphraseEnabled: false, syncMode: 'plain', e2eeMigration: migration });
  await upsertRemoteSyncAccount('plain', migration, { activeDekVersion: null, pendingDekVersion: null });
  lastSynced.record();
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

  // Unwrap the (old) DEK with the recovery KEK. A failure here is the canonical
  // "wrong code" signal — surface it as a clean error rather than a paused
  // migration, since nothing destructive has happened yet.
  const recoveryKek = await deriveRecoveryKek(recoveryCode, bundle.recoverySaltB64);
  let oldDek: string;
  try {
    oldDek = await unwrapDek(
      recoveryKek,
      bundle.recoveryWrapped.ciphertext,
      bundle.recoveryWrapped.iv,
    );
  } catch {
    throw new Error("That recovery code didn't unlock your data.");
  }

  // Recovery may be invoked from a syncMode that isn't 'e2ee' (e.g. on a
  // brand-new device where profile.syncMode is undefined / 'plain'). Make
  // sure the profile reflects E2EE so the rotation prelude doesn't reject
  // the run.
  const profile = await getProfile();
  if (getProfileSyncMode(profile) !== 'e2ee') {
    await saveProfile({ passphraseEnabled: true, syncMode: 'e2ee' });
  }

  // Rotate: re-encrypt the server's rows from the recovered DEK to a fresh one
  // wrapped under the new passphrase. Works with no local data — it re-encrypts
  // the server ciphertext directly.
  return beginKeyRotation(oldDek, newPassphrase);
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

  // A key rotation can't be finished silently: re-encrypting the rows still
  // under the old DEK needs the OLD passphrase (the cached session key is the
  // new DEK), so always route rotation resumes through the passphrase UI.
  if (mode === 'rotating_e2ee_key') {
    return { status: 'needs-passphrase', direction: 'rotate' };
  }

  // For enable/disable the DEK is normally still in localStorage after a crash
  // (the session key is persisted), so this resumes silently. When it isn't
  // (logout wiped it, persistence failed, or this device just took over), ask
  // the UI to collect the passphrase instead.
  if (!getSessionKey()) {
    return { status: 'needs-passphrase', direction: directionFor(migration, mode) };
  }

  // Session key present, so the continue* helpers use the cached DEK and the
  // empty passphrase argument is never consulted.
  const result =
    mode === 'migrating_to_plain'
      ? await continueE2EEDisableMigration('')
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

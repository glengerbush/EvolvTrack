import { DB_SCHEMA_VERSION, db, type EncryptedRecord } from '$lib/db/schema';
import { nanoid } from 'nanoid';
import {
  getAllEntries,
  getAllPrescriptions,
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
  PBKDF2_ITERATIONS,
  decryptRecord,
  derivePassphraseKek,
  deriveRecoveryKek,
  encryptRecord,
  generateSaltB64,
  unwrapDek,
  wrapDek,
} from '$lib/crypto/e2ee';
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import { lastSynced } from '$lib/stores/syncStore';
import { errorMessage } from '$lib/utils/errorMessage';
import {
  abandonSyncTransition,
  advanceSyncTransitionPhase,
  beginSyncTransition,
  claimMigrationOwner,
  completeSyncTransition,
  fetchRemoteSyncAccount,
  getDeviceId,
  MigrationSupersededError,
  startFreshSync,
} from '$lib/sync/account-state';
import { pullSnapshotForMigration } from '$lib/sync/sync-engine';
import {
  remoteSyncLogTransfer,
  type EncryptedSyncChange,
} from '$lib/sync/remote-sync-log-transfer';
import { deviceEncryptionState } from '$lib/sync/device-encryption-state';
import {
  canonicalSyncChange,
  type PlainSyncChange,
} from '$lib/sync/canonical-sync-change';

type BackfillItem = {
  aggregate: SyncAggregate;
  id: string;
  op: 'upsert' | 'delete';
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
type ProgressReporter = (converted: number, total: number) => Promise<void> | void;

/**
 * How many migration runs (enable / disable / rotate, started here or resumed
 * from the modal) are executing in THIS tab right now. A counter rather than a
 * boolean because the public entry points nest (e.g. `startE2EEKeyRotation`
 * delegates to `resumeE2EEKeyRotation`).
 *
 * The orchestrator's `autoResumeMigration` consults this: while a run owns the
 * transition locally, a concurrent sync cycle must not independently drive the
 * same migration or publish a stale credential-required snapshot.
 */
let activeMigrationRuns = 0;

/** True while a migration run is executing in this tab. See {@link activeMigrationRuns}. */
export function isMigrationRunInProgress(): boolean {
  return activeMigrationRuns > 0;
}

/** Run `fn` while marking a migration as actively in progress in this tab. */
async function withMigrationRun<T>(fn: () => Promise<T>): Promise<T> {
  activeMigrationRuns++;
  try {
    return await fn();
  } finally {
    activeMigrationRuns--;
  }
}

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
  /** Set when the run stopped because another device took the migration over.
   * The caller must NOT treat this as an error — the new owner is finishing it
   * and the next reconcile converges this device. */
  superseded?: boolean;
};

export type E2EEMigrationRunOptions = {
  onRecoveryCode?: (code: string) => void;
};

function nowIso() {
  return new Date().toISOString();
}


/**
 * Re-check, against the server, that this device still owns the given migration
 * before doing anything destructive (deleting plaintext, dropping the old key
 * bundle, flipping the mode). If another device has taken it over, throw
 * `MigrationSupersededError` so the caller bails WITHOUT writing failure state.
 */
async function assertStillMigrationOwner(migrationId: string): Promise<void> {
  const remote = await fetchRemoteSyncAccount();
  const m = remote?.migration;
  if (!m || m.id !== migrationId || m.ownerDeviceId !== getDeviceId()) {
    throw new MigrationSupersededError();
  }
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
    phase: 'preparing',
    ownerDeviceId: getDeviceId(),
    startedAt: timestamp,
    updatedAt: timestamp,
    plaintextHighWaterMark: timestamp,
  };
}

const PHASE_RANK = {
  preparing: 1,
  transferring: 2,
  verifying: 3,
  finalizing: 4,
} as const;

async function advanceMigrationPhase(
  migration: E2EEMigrationState,
  phase: NonNullable<E2EEMigrationState['phase']>,
): Promise<void> {
  const currentRank = migration.phase ? PHASE_RANK[migration.phase] : 0;
  if (currentRank >= PHASE_RANK[phase]) return;
  await advanceSyncTransitionPhase({
    migrationId: migration.id,
    ownerDeviceId: migration.ownerDeviceId,
    phase,
  });
  migration.phase = phase;
  migration.updatedAt = nowIso();
  await saveProfile({ e2eeMigration: { ...migration } });
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
  const [entries, prescriptions, profile] = await Promise.all([
    getAllEntries(),
    getAllPrescriptions(),
    getProfile(),
  ]);

  const items: BackfillItem[] = [
    ...entries.map((record) => ({
      aggregate: 'entry' as const,
      id: record.id,
      op: 'upsert' as const,
      updatedAt: record.updatedAt,
      payload: record,
    })),
    ...prescriptions.map((record) => ({
      aggregate: 'prescription' as const,
      id: record.id,
      op: 'upsert' as const,
      updatedAt: record.updatedAt,
      payload: record,
    })),
  ];

  if (profile) {
    items.push({
      aggregate: 'profile',
      id: 'profile',
      op: 'upsert',
      updatedAt: profile.updatedAt ?? nowIso(),
      payload: profilePayload(profile),
    });
  }

  return items;
}

async function backfillEncryptedRecords(
  dek: string,
  migrationId: string,
  remoteChanges: PlainSyncChange[],
  onProgress?: ProgressReporter,
): Promise<number> {
  const localItems = await collectBackfillItems();
  const items = [...new Map(
    [
      ...localItems,
      ...remoteChanges.map((change) => ({
        aggregate: change.aggregate,
        id: canonicalSyncChange.entityId(change.id),
        op: change.op,
        updatedAt: change.createdAt ?? nowIso(),
        payload: change.op === 'delete' ? null : change.payload,
      })),
    ]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((item) => [`${item.aggregate}:${item.id}`, item] as const),
  ).values()];
  const encryptedRecords: EncryptedRecord[] = [];
  const backfillEntries: MigrationBackfillEntry[] = [];
  const total = items.length;
  let converted = 0;

  // Report a zero-progress tick up front so watchers learn the total (and that
  // work has started) before the first record finishes encrypting.
  if (onProgress) await onProgress(0, total);

  for (const item of items) {
    const change = canonicalPlainChange(
      item.aggregate,
      item.op,
      item.payload,
      `${item.aggregate}:${item.id}`,
      item.updatedAt,
    );
    const encrypted = await canonicalSyncChange.seal(change, dek, { migrationId });

    encryptedRecords.push({
      id: encrypted.id,
      entity: item.aggregate,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: encrypted.encryptionVersion,
      updatedAt: item.updatedAt,
    });

    backfillEntries.push({
      // Canonical `${aggregate}:${entityId}` — the SAME id steady-state encrypted
      // pushes use — so an enable-backfill row and a later steady-state row for
      // the same entity upsert into ONE server row instead of two. Two rows per
      // entity would otherwise collapse to a duplicate id when disabling and
      // crash the plaintext upsert. (`migrationId` lives inside the ciphertext.)
      id: encrypted.id,
      aggregate: item.aggregate,
      op: item.op,
      payloadCiphertext: encrypted.ciphertext,
      payloadIv: encrypted.iv,
      protocolVersion: encrypted.protocolVersion,
      encryptionVersion: encrypted.encryptionVersion,
      schemaVersion: encrypted.schemaVersion,
      createdAt: encrypted.createdAt,
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
  encryptionVersion?: number,
): PlainSyncChange {
  return canonicalSyncChange.fromRecord({
    aggregate,
    op,
    record,
    sourceId: fallbackSourceId,
    sourceUpdatedAt: fallbackUpdatedAt,
    protocolVersion,
    schemaVersion,
    encryptionVersion,
  });
}

async function collectPlainChangesFromLocalRecords(): Promise<PlainSyncChange[]> {
  const items = await collectBackfillItems();
  return items.map((item) =>
    canonicalPlainChange(
      item.aggregate,
      'upsert',
      item.payload,
      `${item.aggregate}:${item.id}`,
      item.updatedAt,
    ),
  );
}

async function collectEncryptedBackfillChanges(dekVersion: number): Promise<EncryptedSyncChange[]> {
  return (await db.migrationBackfill.orderBy('createdAt').toArray()).map((row) => ({
    id: row.id,
    ciphertext: row.payloadCiphertext,
    iv: row.payloadIv,
    protocolVersion: row.protocolVersion,
    encryptionVersion: row.encryptionVersion,
    dekVersion,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
  }));
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
      canonicalPlainChange(
        aggregate,
        op,
        record,
        row.id,
        row.createdAt,
        row.protocolVersion,
        row.schemaVersion,
        row.encryptionVersion,
      ),
    );
  }

  return {
    plainChanges,
    encryptedChangeIds: rows.map((row) => row.id),
  };
}

async function decryptRemoteBackfill(dek: string) {
  // Only fetch rows under the DEK version this device's bundle actually holds.
  // A row tagged with a different version (an orphan from a crashed rotation, or
  // from cycling E2EE on/off) can't be opened with `dek` and would otherwise
  // throw and wedge the whole disable — the same reason `pullEncrypted`
  // version-filters. Orphan-version rows are swept by the unconditional
  // `deleteRemoteEncryptedChanges()` at the end of the disable.
  const dekVersion = (await deviceEncryptionState.getActiveWrappedKeyBundle())?.dekVersion ?? 1;
  const rows = await remoteSyncLogTransfer.readEncrypted(dekVersion);
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
        row.encryptionVersion,
      ),
    );
  }

  return {
    plainChanges,
    encryptedChangeIds: rows.map((row: EncryptedSyncChange) => row.id),
  };
}

/**
 * Unwrap the DEK from the locally-cached bundle using the supplied passphrase.
 * Used by resume/disable flows where the bundle was minted on a previous run.
 */
async function unwrapDekWithPassphrase(passphrase: string): Promise<string> {
  return deviceEncryptionState.unwrapWithPassphrase(passphrase);
}

async function finishE2EEMigration(migration: E2EEMigrationState): Promise<E2EEMigrationState> {
  await advanceMigrationPhase(migration, 'finalizing');
  const completedAt = nowIso();
  const completedMigration: E2EEMigrationState = {
    ...migration,
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  };

  // Copy-before-delete, ownership, and source verification completed in the
  // remote-transfer module before finalization.
  // Record the now-active DEK version (the bundle everything was just encrypted
  // under) and clear any pending-rotation marker. Guarded: completes only if we
  // still own this migration, else throws MigrationSupersededError.
  const activeBundle = await deviceEncryptionState.getActiveWrappedKeyBundle();
  await completeSyncTransition({
    migrationId: migration.id,
    ownerDeviceId: migration.ownerDeviceId,
    to: 'e2ee',
    activeDekVersion: activeBundle?.dekVersion ?? 1,
  });
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'e2ee',
    e2eeMigration: completedMigration,
  });
  // Steady-state sync now pulls `sync_changes_encrypted` instead of `sync_changes_plain`.
  // The pull cursor tracked the old table's `inserted_at` sequence, so it is
  // meaningless against the new one — reset it and let the next pull refetch.
  deviceEncryptionState.resetPullCursorForTableSwitch();
  // The whole dataset is now on the server under the new mode — that's a
  // completed sync. Stamp it so "Last synced" reflects a real completion, not a
  // mid-flight push step (which is why the granular push/delete helpers no
  // longer record it).
  lastSynced.record();

  return completedMigration;
}

function continueE2EEMigration(
  passphrase: string,
  recoveryCode?: string,
): Promise<E2EEMigrationRunResult> {
  return withMigrationRun(() => continueE2EEMigrationImpl(passphrase, recoveryCode));
}

async function continueE2EEMigrationImpl(
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
    let dek = deviceEncryptionState.getSessionKey();
    if (!dek) {
      dek = await unwrapDekWithPassphrase(passphrase);
      deviceEncryptionState.activateSessionKey(dek);
    }

    // Absorb anything that lives only on the server before we re-encrypt and
    // (in finish) delete the plaintext table. Covers a migration interrupted
    // by a crash/quit: another device may have pushed plaintext rows, or a
    // prior partial run of this migration already pushed encrypted rows, that
    // this device never pulled. Idempotent (LWW), so re-running on resume is
    // safe.
    await pullSnapshotForMigration(dek);

    const report = remoteSyncLogTransfer.createProgressReporter(migration, MIGRATION_HEARTBEAT_MS);
    const remotePlainChanges = await remoteSyncLogTransfer.readPlain();
    const encryptedEventCount = await backfillEncryptedRecords(
      dek,
      migration.id,
      remotePlainChanges,
      report,
    );
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      encryptedEventCount,
      recordsTotal: encryptedEventCount,
      recordsConverted: encryptedEventCount,
      updatedAt: nowIso(),
      lastError: undefined,
    };

    await saveProfile({ e2eeMigration: updatedMigration });
    // Heartbeat right before the (potentially slow) push + finalize so a
    // watching device's stale timer resets at the start of this phase.
    await remoteSyncLogTransfer.heartbeat(updatedMigration).catch(() => undefined);

    const pushed = await remoteSyncLogTransfer.copyEncryptedThenRemovePlain({
      changes: await collectEncryptedBackfillChanges((await deviceEncryptionState.getActiveWrappedKeyBundle())?.dekVersion ?? 1),
      migration: updatedMigration,
    });
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
    if (error instanceof MigrationSupersededError) {
      // Another device took this enable over. Leave server state untouched so
      // we don't clobber the new owner; the next reconcile adopts it.
      return {
        syncMode: 'migrating_to_e2ee',
        migration,
        recoveryCode,
        encryptedEventCount: migration.encryptedEventCount ?? 0,
        pushed: 0,
        completed: false,
        superseded: true,
      };
    }
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
    await remoteSyncLogTransfer.heartbeat(failedMigration).catch(() => undefined);

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

export async function startE2EEMigration(
  passphrase: string,
  options: E2EEMigrationRunOptions = {},
): Promise<E2EEMigrationRunResult> {
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
  await advanceMigrationPhase(migration, 'transferring');
  try {
    await remoteSyncLogTransfer.removeEncrypted();
    await deviceEncryptionState.removeCloudKeyMaterial();
  } catch (cause) {
    throw new Error(
      `Couldn't clear the previous encrypted data before enabling (${errorMessage(cause)}). ` +
        'Check your connection and try again.',
    );
  }

  const { dek, recoveryCode } = await deviceEncryptionState.createWrappedKeyBundle(
    passphrase,
    dekVersion,
  );
  options.onRecoveryCode?.(recoveryCode);
  deviceEncryptionState.activateSessionKey(dek);

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
  await advanceMigrationPhase(migration, 'finalizing');
  const completedAt = nowIso();
  const completedMigration: E2EEMigrationState = {
    ...migration,
    updatedAt: completedAt,
    completedAt,
    plaintextEventCount,
    deletedEncryptedEventCount,
    lastError: undefined,
  };

  // Guarded finalize atomically deletes cloud key material while holding the
  // account transition lock. A superseded owner changes nothing.
  await completeSyncTransition({
    migrationId: migration.id,
    ownerDeviceId: migration.ownerDeviceId,
    to: 'plain',
    activeDekVersion: null,
  });
  await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
  });
  await deviceEncryptionState.clearForPlainMode();
  await saveProfile({
    passphraseEnabled: false,
    syncMode: 'plain',
    e2eeMigration: completedMigration,
  });
  // A completed disable is a completed sync — see finishE2EEMigration.
  lastSynced.record();

  return completedMigration;
}

function continueE2EEDisableMigration(passphrase: string): Promise<E2EEMigrationRunResult> {
  return withMigrationRun(() => continueE2EEDisableMigrationImpl(passphrase));
}

async function continueE2EEDisableMigrationImpl(passphrase: string): Promise<E2EEMigrationRunResult> {
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
    let dek = deviceEncryptionState.getSessionKey();
    if (!dek) {
      dek = await unwrapDekWithPassphrase(passphrase);
      deviceEncryptionState.activateSessionKey(dek);
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
    const convertedPlainChanges = decryptedPlainChanges.length
      ? decryptedPlainChanges
      : await collectPlainChangesFromLocalRecords();

    // Fold in whatever already lives in the plaintext table — e.g. a row a device
    // pushed there before it learned the disable was underway (RLS lets plain
    // writes through in `migrating_to_plain`). `pushPlainChanges` dedupes by id
    // keeping the newest `createdAt`, so a newer plain row is never clobbered by
    // an older encrypted-derived one. This is the "handle both tables" half of a
    // correct take-over: the encrypted source is converted AND existing plaintext
    // is preserved.
    const remotePlainChanges = await remoteSyncLogTransfer.readPlain();
    const plainChanges = [...convertedPlainChanges, ...remotePlainChanges];

    const plaintextEventCount = plainChanges.length;
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      plaintextEventCount,
      updatedAt: nowIso(),
      lastError: undefined,
    };

    await saveProfile({ e2eeMigration: updatedMigration });
    // Heartbeat (owner-scoped, no mode write) before the push + finalize.
    await remoteSyncLogTransfer.heartbeat(updatedMigration).catch(() => undefined);

    const transfer = await remoteSyncLogTransfer.copyPlainThenRemoveEncrypted({
      changes: plainChanges,
      migration: updatedMigration,
    });
    const completedMigration = await finishE2EEDisableMigration(
      updatedMigration,
      plaintextEventCount,
      transfer.deleted,
    );

    return {
      syncMode: 'plain',
      migration: completedMigration,
      encryptedEventCount: encryptedChangeIds.length,
      plaintextEventCount,
      deletedEncryptedEventCount: transfer.deleted,
      pushed: transfer.pushed,
      completed: true,
    };
  } catch (error) {
    if (error instanceof MigrationSupersededError) {
      // Another device took this disable over. Leave server state untouched.
      return {
        syncMode: 'migrating_to_plain',
        migration,
        encryptedEventCount: migration.encryptedEventCount ?? 0,
        plaintextEventCount: migration.plaintextEventCount,
        deletedEncryptedEventCount: migration.deletedEncryptedEventCount,
        pushed: 0,
        completed: false,
        superseded: true,
      };
    }
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
    await remoteSyncLogTransfer.heartbeat(failedMigration).catch(() => undefined);

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
  const kek = await derivePassphraseKek(passphrase, bundle.passphraseSaltB64, bundle.passphraseIterations);
  return unwrapDek(kek, bundle.passphraseWrapped.ciphertext, bundle.passphraseWrapped.iv);
}

/**
 * Run (or resume) the re-encrypt + finalize half of a rotation, given both
 * DEKs. Returns a completed result, or a paused one if anything fails — which
 * leaves the rotation resumable, because both bundles and the old-version rows
 * are still in place until the very end.
 */
function driveRotation(
  oldDek: string,
  oldVersion: number,
  newDek: string,
  newVersion: number,
  migration: E2EEMigrationState,
  recoveryCode?: string,
): Promise<E2EEMigrationRunResult> {
  return withMigrationRun(() =>
    driveRotationImpl(oldDek, oldVersion, newDek, newVersion, migration, recoveryCode),
  );
}

async function driveRotationImpl(
  oldDek: string,
  oldVersion: number,
  newDek: string,
  newVersion: number,
  migration: E2EEMigrationState,
  recoveryCode?: string,
): Promise<E2EEMigrationRunResult> {
  try {
    deviceEncryptionState.activateSessionKey(newDek);
    const report = remoteSyncLogTransfer.createProgressReporter(migration, MIGRATION_HEARTBEAT_MS);
    // Re-encrypt every old-version row to the new DEK, then converge: loop until
    // a pass converts nothing. A device that hasn't yet reconciled the rotating
    // mode can still push a row under the OLD dek (RLS permits encrypted writes
    // while `rotating_e2ee_key`), and one landing *after* the first pass's scan
    // would otherwise be orphaned — stranded on the old version, filtered out of
    // every future pull once the old bundle is dropped below. Each pass only
    // touches rows still on the old version, so this is idempotent and never
    // double-counts; the cap bounds the rare case of a device that keeps pushing
    // (it stops once it adopts the rotation mode a cycle later).
    let converted = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      const n = await remoteSyncLogTransfer.rotateCiphertext({
        oldDek,
        oldVersion,
        newDek,
        newVersion,
        onProgress: pass === 0 ? report : undefined,
      });
      converted += n;
      if (n === 0) break;
    }
    const obsoleteRows = await remoteSyncLogTransfer.readEncrypted(oldVersion);
    if (obsoleteRows.length > 0) {
      throw new Error(
        `${obsoleteRows.length} encrypted change(s) still require the previous encryption key.`,
      );
    }
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      encryptedEventCount: converted,
      recordsTotal: converted,
      recordsConverted: converted,
      updatedAt: nowIso(),
      lastError: undefined,
    };
    await saveProfile({ e2eeMigration: updatedMigration });
    await remoteSyncLogTransfer.heartbeat(updatedMigration).catch(() => undefined);

    await advanceMigrationPhase(updatedMigration, 'verifying');

    // Re-check ownership before finalization. The guarded completion RPC fences
    // concurrent writes, verifies no obsolete-version rows remain, and removes
    // the old wrapped key in the same transaction.
    await assertStillMigrationOwner(migration.id);
    await advanceMigrationPhase(updatedMigration, 'finalizing');
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
    if (error instanceof MigrationSupersededError) {
      // Another device took this rotation over. Both bundles + old-version rows
      // are still in place (we hadn't dropped them), so the new owner resumes
      // cleanly. Leave server state untouched.
      return {
        syncMode: 'rotating_e2ee_key',
        migration,
        recoveryCode,
        encryptedEventCount: migration.encryptedEventCount ?? 0,
        pushed: 0,
        completed: false,
        superseded: true,
      };
    }
    const message = errorMessage(error);
    const failedMigration: E2EEMigrationState = { ...migration, updatedAt: nowIso(), lastError: message };
    await saveProfile({ passphraseEnabled: true, syncMode: 'rotating_e2ee_key', e2eeMigration: failedMigration });
    await remoteSyncLogTransfer.heartbeat(failedMigration).catch(() => undefined);
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
  options: E2EEMigrationRunOptions = {},
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
  await advanceMigrationPhase(migration, 'transferring');
  const { dek: newDek, recoveryCode } = await deviceEncryptionState.createWrappedKeyBundle(
    newPassphrase,
    newVersion,
  );
  options.onRecoveryCode?.(recoveryCode);
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
  options: E2EEMigrationRunOptions = {},
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

  const oldBundle = await deviceEncryptionState.getActiveWrappedKeyBundle();
  if (!oldBundle) {
    throw new Error('No local key bundle is present. Unlock on this device before rotating.');
  }
  // Proof of possession AND the old DEK: only proceed if the supplied passphrase
  // actually unwraps the current bundle.
  const oldDek = await deriveDekFromBundle(oldBundle, currentPassphrase);
  return beginKeyRotation(oldDek, newPassphrase ?? currentPassphrase, options);
}

/**
 * Resume a rotation — same device after a crash, or a fresh device. Needs the
 * passphrase for each in-flight bundle: `oldPassphrase` unwraps the old bundle
 * (to decrypt rows still under it) and `newPassphrase` unwraps the new one. For
 * a panic rotate they're identical, so `newPassphrase` defaults to `oldPassphrase`.
 */
export function resumeE2EEKeyRotation(
  oldPassphrase: string,
  newPassphrase?: string,
): Promise<E2EEMigrationRunResult> {
  return withMigrationRun(() => resumeE2EEKeyRotationImpl(oldPassphrase, newPassphrase));
}

async function resumeE2EEKeyRotationImpl(
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
    const bundles = await deviceEncryptionState.getRotationKeyBundles(); // ascending by version
    if (bundles.length === 0) throw new Error('No key bundle is associated with this account.');

    const newBundle = bundles[bundles.length - 1];
    newVersion = newBundle.dekVersion;
    newDek = await deriveDekFromBundle(newBundle, np);
    const { id: _id, ...withoutId } = newBundle;
    await deviceEncryptionState.cacheActiveWrappedKeyBundle(withoutId);

    if (bundles.length === 1) {
      // The old bundle is already gone → the re-encrypt finished on a previous
      // run; just finalize into steady-state e2ee under the new key.
      deviceEncryptionState.activateSessionKey(newDek);
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
    // Owner-scoped heartbeat (NOT upsertRemoteSyncAccount) so a resume that fails
    // after another device took the rotation over can't clobber the new owner's
    // claim / mode — matches the other run-failure catches. No-ops if superseded.
    await remoteSyncLogTransfer.heartbeat(failedMigration).catch(() => undefined);
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
  let plainChanges = await collectPlainChangesFromLocalRecords();

  // Refuse if this device has no actual health data to keep (a lone profile row
  // doesn't count). The encrypted server copy is unreadable — that's why we're
  // here — so wiping it without a local copy to re-upload would erase the only
  // remaining data. Recovery must come from a device that still has the data,
  // or from the passphrase / recovery-code flow.
  let dataChanges = plainChanges.filter((c) => c.aggregate !== 'profile');
  if (dataChanges.length === 0) {
    const encryptedChanges = await deviceEncryptionState.readLocalEncryptedChanges();
    plainChanges = canonicalSyncChange.dedupe([...plainChanges, ...encryptedChanges]);
    dataChanges = plainChanges.filter((change) => change.aggregate !== 'profile');
  }
  if (dataChanges.length === 0) {
    throw new Error(
      'There is no data on this device to keep, so resetting would erase your only copy. ' +
        'Recover with your passphrase or recovery code on a device that has your data instead.',
    );
  }

  // 1. Claim a gated transition into `migrating_to_plain` BEFORE writing any
  //    plaintext. This does two things the old direct-to-plain write couldn't:
  //    (a) it flips the server mode so RLS permits the plaintext upsert below —
  //        without it, `sync_mode_allows_plain` rejects the push whenever the
  //        account is wedged in a non-plain mode, which is exactly when reset is
  //        needed; and
  //    (b) it parks every other device in the gated disable state (and claims
  //        cross-device mutual exclusion) so they stop syncing encrypted rows
  //        while we tear the encrypted copy down.
  const migration = createMigration('disable');
  await beginSyncTransition({
    from: ['plain', 'e2ee', 'migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key'],
    to: 'migrating_to_plain',
    migration,
    allocateNewDek: false,
  });
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'migrating_to_plain',
    e2eeMigration: migration,
  });

  // 2. Push this device's records to the plaintext table, so the data is safely
  //    on the server before anything is deleted. Canonical envelope rows (see
  //    pushPlainChanges), LWW-merged by other devices on their next pull.
  const transfer = await remoteSyncLogTransfer.copyPlainThenRemoveEncrypted({
    changes: plainChanges,
    migration,
  });

  await advanceMigrationPhase(migration, 'finalizing');

  // 3. Finalize authoritatively before deleting recovery material. If this
  //    device lost ownership, the key remains available to the new owner.
  const completedAt = nowIso();
  const completedMigration: E2EEMigrationState = {
    ...migration,
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  };
  await completeSyncTransition({
    migrationId: migration.id,
    ownerDeviceId: migration.ownerDeviceId,
    to: 'plain',
    activeDekVersion: null,
  });

  // 4. The server is safely plain; clear local encrypted scratch.
  await db.transaction('rw', db.encrypted, db.migrationBackfill, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
  });
  await deviceEncryptionState.clearForPlainMode();

  // 5. Land in a clean local plaintext state.
  await saveProfile({
    passphraseEnabled: false,
    syncMode: 'plain',
    e2eeMigration: completedMigration,
  });
  lastSynced.record();

  return { pushed: transfer.pushed };
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
 * confirmation first. Local recovery material is retained unless the atomic
 * server transaction commits and authoritative mode becomes plain.
 */
export async function startFreshToPlain(): Promise<void> {
  // Claim a gated transition first (same discipline as resetEncryptionToPlain):
  // parks every other device in the gated disable state and takes cross-device
  // mutual exclusion, so a concurrent edit/transition elsewhere can't re-pollute
  // the tables we're about to erase.
  const migration = createMigration('disable');
  await beginSyncTransition({
    from: ['plain', 'e2ee', 'migrating_to_e2ee', 'migrating_to_plain', 'rotating_e2ee_key'],
    to: 'migrating_to_plain',
    migration,
    allocateNewDek: false,
  });
  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'migrating_to_plain',
    e2eeMigration: migration,
  });

  await advanceMigrationPhase(migration, 'finalizing');
  await startFreshSync({
    migrationId: migration.id,
    ownerDeviceId: migration.ownerDeviceId,
  });

  // The server transaction committed. Only now discard device recovery
  // material; a thrown/lost request leaves everything intact for reconciliation.
  await db.transaction('rw', db.encrypted, db.migrationBackfill, db.outbox, async () => {
    await db.encrypted.clear();
    await db.migrationBackfill.clear();
    await db.outbox.clear();
  });
  await deviceEncryptionState.clearForPlainMode();

  const completedAt = nowIso();
  const completedMigration: E2EEMigrationState = {
    ...migration,
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  };
  await saveProfile({
    passphraseEnabled: false,
    syncMode: 'plain',
    e2eeMigration: completedMigration,
  });
  lastSynced.record();
}

export async function abandonPreparedTransition(): Promise<void> {
  const profile = await getProfile();
  const migration = profile?.e2eeMigration;
  if (!migration || migration.ownerDeviceId !== getDeviceId() || migration.phase !== 'preparing') {
    throw new Error('Only an owned, prepared Encryption Transition can be abandoned.');
  }
  await abandonSyncTransition({
    migrationId: migration.id,
    ownerDeviceId: migration.ownerDeviceId,
  });
  const syncMode: SyncMode = migration.direction === 'enable' ? 'plain' : 'e2ee';
  await saveProfile({
    syncMode,
    passphraseEnabled: syncMode === 'e2ee',
    e2eeMigration: undefined,
  });
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
  options: E2EEMigrationRunOptions = {},
): Promise<E2EEMigrationRunResult> {
  if (!recoveryCode?.trim()) throw new Error('Recovery code is required.');
  if (!newPassphrase) throw new Error('New passphrase is required.');

  let bundle: WrappedKeyBundle;
  try {
    bundle = await deviceEncryptionState.requireWrappedKeyBundle();
  } catch {
    throw new Error('No encrypted account is associated with this user.');
  }

  // Unwrap the (old) DEK with the recovery KEK. A failure here is the canonical
  // "wrong code" signal — surface it as a clean error rather than a paused
  // migration, since nothing destructive has happened yet.
  if (!bundle.recoverySaltB64 || !bundle.recoveryWrapped || !bundle.recoveryIterations) {
    throw new Error('No recovery code is configured for this encryption key.');
  }
  const recoveryKek = await deriveRecoveryKek(recoveryCode, bundle.recoverySaltB64, bundle.recoveryIterations);
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
  return beginKeyRotation(oldDek, newPassphrase, options);
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
  | { status: 'in-progress' }
  | ({ status: 'awaiting-takeover'; direction: E2EEMigrationDirection; ownerDeviceId: string } & MigrationProgress)
  | { status: 'needs-passphrase'; direction: E2EEMigrationDirection }
  | { status: 'superseded' }
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
 *  - `in-progress`      — a migration run already owns the transition in THIS
 *                         tab (kicked off from settings, or the modal's Resume).
 *                         The orchestrator must stand down: it must not raise a
 *                         resume prompt or try to drive the same migration.
 *  - `awaiting-takeover`— a migration is in progress but owned by *another*
 *                         device. This device can adopt it (see
 *                         `takeOverMigration`) once the user opts in; until
 *                         then it does nothing so two devices don't race.
 *  - `needs-passphrase` — a migration owned by this device is in progress but
 *                         the session is locked (no cached DEK); the UI must
 *                         collect the passphrase and call `resume*`.
 *  - `superseded`       — this device began driving the migration but another
 *                         device took it over mid-run. NOT an error: stand down
 *                         and let the next reconcile adopt the new owner (which
 *                         surfaces the take-over banner). No server state was
 *                         touched by the aborted run.
 *  - `resumed`          — the migration finished; the device is now in its
 *                         steady-state mode.
 *  - `paused`           — resume attempted but failed (e.g. network); the
 *                         device stays migrating and the next cycle retries.
 */
export async function autoResumeMigration(): Promise<AutoResumeResult> {
  // A migration run is already executing in this tab (the user started it from
  // settings, or hit Resume in the modal). It owns the transition and drives its
  // own UI; a concurrent sync cycle must not independently drive the same
  // migration or publish stale lifecycle state.
  if (isMigrationRunInProgress()) return { status: 'in-progress' };

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
  if (!deviceEncryptionState.getSessionKey()) {
    return { status: 'needs-passphrase', direction: directionFor(migration, mode) };
  }

  // Session key present, so the continue* helpers use the cached DEK and the
  // empty passphrase argument is never consulted.
  const result =
    mode === 'migrating_to_plain'
      ? await continueE2EEDisableMigration('')
      : await continueE2EEMigration('');

  // A take-over by another device mid-run is a clean hand-off, not a failure:
  // the aborted run left server state untouched, so don't surface it as a paused
  // error. The next reconcile adopts the new owner → take-over banner.
  if (result.superseded) return { status: 'superseded' };
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

  // Claim ownership on the server FIRST, via an atomic compare-and-swap on the
  // owner this device last observed. If two waiting devices both try to take the
  // same migration over, only one wins; the loser gets SyncTransitionConflictError
  // and we stamp nothing locally (so we never drive a migration we lost). Mode is
  // unchanged (still `migrating_*`), so this never rewrites it.
  await claimMigrationOwner({
    migrationId: migration.id,
    expectedOwnerDeviceId: migration.ownerDeviceId,
    newOwnerDeviceId: getDeviceId(),
  });

  const claimed: E2EEMigrationState = {
    ...migration,
    ownerDeviceId: getDeviceId(),
    updatedAt: nowIso(),
    lastError: undefined,
  };

  await saveProfile({ e2eeMigration: claimed });
}

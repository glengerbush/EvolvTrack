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
import type { E2EEMigrationDirection, E2EEMigrationState, MigrationBackfillEntry, ProfileSettings, SyncAggregate, SyncMode } from '$lib/domain/types';
import {
  ENCRYPTION_FORMAT_VERSION,
  clearPassphraseMaterial,
  decryptRecord,
  encryptRecord,
  generateRecoveryCodes,
  initializePassphrase,
} from '$lib/crypto/e2ee';
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import { getDeviceId, upsertRemoteSyncAccount } from '$lib/sync/account-state';
import { clearSessionPassphrase, setSessionPassphrase } from '$lib/sync/session-key';
import { clearPullCursor } from '$lib/sync/pull-cursor';
import {
  deleteRemoteEncryptedChanges,
  fetchRemoteEncryptedChanges,
  pushEncryptedChanges,
  pushPlainChanges,
  type EncryptedSyncChange,
  type PlainSyncChange,
} from '$lib/sync/sync-engine';

type BackfillItem = {
  aggregate: SyncAggregate;
  id: string;
  updatedAt: string;
  payload: unknown;
};

export type E2EEMigrationRunResult = {
  syncMode: SyncMode;
  migration: E2EEMigrationState;
  recoveryCodes?: string[];
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

async function backfillEncryptedRecords(passphrase: string, migrationId: string): Promise<number> {
  const items = await collectBackfillItems();
  const encryptedRecords: EncryptedRecord[] = [];
  const backfillEntries: MigrationBackfillEntry[] = [];

  for (const item of items) {
    const encrypted = await encryptRecord(passphrase, {
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

async function decryptLocalBackfill(passphrase: string, migrationId: string) {
  const rows = await db.migrationBackfill.orderBy('createdAt').toArray();
  const plainChanges: PlainSyncChange[] = [];

  for (const row of rows) {
    const decrypted = await decryptRecord<EncryptedSyncPayload>(passphrase, row.payloadCiphertext, row.payloadIv);
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

async function decryptRemoteBackfill(passphrase: string, migrationId: string) {
  const rows = await fetchRemoteEncryptedChanges();
  const plainChanges: PlainSyncChange[] = [];

  for (const row of rows) {
    const decrypted = await decryptRecord<EncryptedSyncPayload>(passphrase, row.ciphertext, row.iv);
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
    encryptedChangeIds: rows.map((row: EncryptedSyncChange) => row.id),
  };
}

async function finishE2EEMigration(migration: E2EEMigrationState): Promise<E2EEMigrationState> {
  const completedAt = nowIso();
  const completedMigration: E2EEMigrationState = {
    ...migration,
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  };

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
  recoveryCodes?: string[],
): Promise<E2EEMigrationRunResult> {
  const profile = await getProfile();
  if (getProfileSyncMode(profile) !== 'migrating_to_e2ee' || !profile?.e2eeMigration) {
    throw new Error('No E2EE migration is in progress.');
  }

  const migration = profile.e2eeMigration;
  // Cache the passphrase so steady-state encrypted sync can run without
  // re-prompting once the migration completes.
  setSessionPassphrase(passphrase);

  try {
    const encryptedEventCount = await backfillEncryptedRecords(passphrase, migration.id);
    const updatedMigration: E2EEMigrationState = {
      ...migration,
      encryptedEventCount,
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
      recoveryCodes,
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
      recoveryCodes,
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

  if (syncMode === 'migrating_to_e2ee') {
    return continueE2EEMigration(passphrase);
  }

  const migration = createMigration('enable');
  await initializePassphrase(passphrase);
  const recoveryCodes = generateRecoveryCodes();
  await upsertRemoteSyncAccount('migrating_to_e2ee', migration);

  await saveProfile({
    passphraseEnabled: true,
    syncMode: 'migrating_to_e2ee',
    e2eeMigration: migration,
  });

  return continueE2EEMigration(passphrase, recoveryCodes);
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
  clearPassphraseMaterial();
  clearSessionPassphrase();
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
  // Needed to decrypt the remote events being converted back to plaintext.
  setSessionPassphrase(passphrase);

  try {
    const remoteDecrypted = await decryptRemoteBackfill(passphrase, migration.id);
    const localDecrypted = remoteDecrypted.plainChanges.length
      ? { plainChanges: [] as PlainSyncChange[], encryptedChangeIds: [] as string[] }
      : await decryptLocalBackfill(passphrase, migration.id);
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

import { DB_SCHEMA_VERSION } from '$lib/db/schema';
import type { OutboxEntry, SyncMode } from '$lib/domain/types';
import { ENCRYPTION_FORMAT_VERSION, decryptRecord, encryptRecord } from '$lib/crypto/e2ee';
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import {
  canonicalSyncChange,
  type PlainSyncChange,
  type SyncEnvelope,
} from '$lib/sync/canonical-sync-change';
import type {
  EncryptedSyncLogRow,
  PlainSyncLogRow,
  SyncLogAdapter,
} from '$lib/sync/sync-log-adapter';
import { supabaseSyncLogAdapter } from '$lib/sync/sync-log-supabase-adapter';
import {
  advanceSyncTransitionPhase,
  fetchRemoteSyncAccount,
  getDeviceId,
  heartbeatMigrationProgress,
  MigrationSupersededError,
} from '$lib/sync/account-state';
import { db } from '$lib/db/schema';
import { saveProfile } from '$lib/domain/health-data-storage';
import type { E2EEMigrationState, E2EETransitionPhase } from '$lib/domain/types';

export type RemotePulledChange = {
  aggregate: PlainSyncChange['aggregate'];
  entityId: string;
  op: PlainSyncChange['op'];
  record: unknown;
  remoteUpdatedAt: string;
  insertedAt: string;
};

export type EncryptedSyncChange = Omit<EncryptedSyncLogRow, 'insertedAt'> & { insertedAt?: string };
export type ReEncryptProgress = (converted: number, total: number) => Promise<void> | void;
export type RemoteSyncLogPort = SyncLogAdapter;

function plainRow(change: PlainSyncChange): PlainSyncLogRow {
  return {
    id: change.id,
    aggregate: change.aggregate,
    op: change.op,
    payload: canonicalSyncChange.envelope(change.aggregate, change.op, change.payload),
    protocolVersion: change.protocolVersion,
    schemaVersion: change.schemaVersion,
    createdAt: change.createdAt,
    insertedAt: change.createdAt,
  };
}

/** Remote sync-log policy over production or deterministic in-memory adapters. */
type OutboxRevisionPort = { clearPublished(rows: OutboxEntry[]): Promise<void> };
type TransitionGuard = {
  checkpoint(migration: E2EEMigrationState, phase: E2EETransitionPhase): Promise<void>;
  assertOwnership(migration: E2EEMigrationState): Promise<void>;
};

const noTransitionGuard: TransitionGuard = {
  checkpoint: async () => undefined,
  assertOwnership: async () => undefined,
};

const productionTransitionGuard: TransitionGuard = {
  async checkpoint(migration, phase) {
    const rank = { preparing: 1, transferring: 2, verifying: 3, finalizing: 4 };
    if (migration.phase && rank[migration.phase] >= rank[phase]) return;
    await advanceSyncTransitionPhase({
      migrationId: migration.id,
      ownerDeviceId: migration.ownerDeviceId,
      phase,
    });
    migration.phase = phase;
    migration.updatedAt = new Date().toISOString();
    await saveProfile({ e2eeMigration: { ...migration } });
  },
  async assertOwnership(migration) {
    const remote = await fetchRemoteSyncAccount();
    if (
      !remote?.migration
      || remote.migration.id !== migration.id
      || remote.migration.ownerDeviceId !== getDeviceId()
    ) throw new MigrationSupersededError();
  },
};

export function createRemoteSyncLogTransfer(
  adapter: SyncLogAdapter,
  outbox: OutboxRevisionPort = { clearPublished: async () => undefined },
  transitionGuard: TransitionGuard = noTransitionGuard,
  readAccount: typeof fetchRemoteSyncAccount = fetchRemoteSyncAccount,
) {
  async function pullPlain(after: string | null = null, rejectMalformed = false): Promise<RemotePulledChange[]> {
    const rows = await adapter.readPlain({ after });
    const changes: RemotePulledChange[] = [];
    for (const row of rows) {
      const envelope = (row.payload ?? {}) as Partial<SyncEnvelope>;
      const decoded = canonicalSyncChange.decode({
        sourceId: row.id,
        envelope: {
          aggregate: envelope.aggregate ?? row.aggregate,
          op: envelope.op ?? row.op,
          record: envelope.record ?? null,
        },
        protocolVersion: row.protocolVersion,
        schemaVersion: row.schemaVersion,
      });
      if (!decoded.accepted) {
        if (rejectMalformed) throw new Error(`Plain sync row ${row.id} was rejected: ${decoded.reason}.`);
        continue;
      }
      changes.push({ ...decoded.change, remoteUpdatedAt: row.createdAt, insertedAt: row.insertedAt });
    }
    return changes;
  }

  async function pullEncrypted(
    after: string | null,
    sessionKey: string,
    dekVersion: number,
  ): Promise<RemotePulledChange[]> {
    const rows = await adapter.readEncrypted({ after, dekVersion });
    const changes: RemotePulledChange[] = [];
    for (const row of rows) {
      let envelope: SyncEnvelope;
      try {
        envelope = await decryptRecord<SyncEnvelope>(sessionKey, row.ciphertext, row.iv);
      } catch (cause) {
        throw new Error(`Failed to decrypt encrypted sync row ${row.id}: ${(cause as Error).message ?? String(cause)}`);
      }
      const decoded = canonicalSyncChange.decode({
        sourceId: row.id,
        envelope,
        protocolVersion: row.protocolVersion,
        schemaVersion: row.schemaVersion,
        encryptionVersion: row.encryptionVersion,
      });
      if (!decoded.accepted) throw new Error(`Encrypted sync row ${row.id} was rejected: ${decoded.reason}.`);
      changes.push({ ...decoded.change, remoteUpdatedAt: row.createdAt, insertedAt: row.insertedAt });
    }
    return changes;
  }

  async function publishPlain(changes: PlainSyncChange[]) {
    const deduped = canonicalSyncChange.dedupe(changes);
    await adapter.writePlain(deduped.map(plainRow));
    return { pushed: deduped.length };
  }

  async function publishEncrypted(changes: EncryptedSyncChange[]) {
    await adapter.writeEncrypted(changes.map((change) => ({
      ...change,
      insertedAt: change.insertedAt ?? change.createdAt,
    })));
    return { pushed: changes.length };
  }

  async function publishOutbox(options: {
    rows: OutboxEntry[];
    syncMode: Extract<SyncMode, 'plain' | 'e2ee'>;
    sessionKey?: string;
    dekVersion: number;
  }): Promise<{ pushed: number }> {
    if (options.syncMode === 'plain') {
      await adapter.writePlain(options.rows.map((row) => plainRow({
        id: row.id,
        aggregate: row.aggregate,
        op: row.op,
        payload: row.payload,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        schemaVersion: DB_SCHEMA_VERSION,
        createdAt: row.updatedAt,
      })));
      return { pushed: options.rows.length };
    }
    if (!options.sessionKey) throw new Error('Encrypted sync requires an unlocked device key.');
    const encrypted: EncryptedSyncLogRow[] = [];
    for (const row of options.rows) {
      const payload = await canonicalSyncChange.seal({
        id: row.id,
        aggregate: row.aggregate,
        op: row.op,
        payload: row.payload,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        schemaVersion: DB_SCHEMA_VERSION,
        createdAt: row.updatedAt,
      }, options.sessionKey);
      encrypted.push({
        ...payload,
        dekVersion: options.dekVersion,
        insertedAt: row.updatedAt,
      });
    }
    await adapter.writeEncrypted(encrypted);
    return { pushed: encrypted.length };
  }

  async function publishSteadyStateOutbox(options: Parameters<typeof publishOutbox>[0]) {
    try {
      const published = await publishOutbox(options);
      await outbox.clearPublished(options.rows);
      return { ...published, modeRejected: false };
    } catch (error) {
      if (adapter.isWriteModeRejection(error)) {
        try {
          const account = await readAccount();
          if (account && account.syncMode !== options.syncMode) {
            return { pushed: 0, modeRejected: true };
          }
        } catch {
          // Preserve the original write failure when confirmation is unavailable.
        }
      }
      throw error;
    }
  }

  function createProgressReporter(base: E2EEMigrationState, intervalMs = 2_000): ReEncryptProgress {
    let lastWriteAt = 0;
    let latest = base;
    return async (converted, total) => {
      const done = total > 0 && converted >= total;
      const now = Date.now();
      if (!done && now - lastWriteAt < intervalMs) return;
      lastWriteAt = now;
      latest = {
        ...latest,
        recordsConverted: converted,
        recordsTotal: total,
        updatedAt: new Date(now).toISOString(),
      };
      await saveProfile({ e2eeMigration: latest });
      await heartbeatMigrationProgress(latest).catch(() => undefined);
    };
  }

  async function readPlain(): Promise<PlainSyncChange[]> {
    return (await pullPlain(null, true)).map((event) => ({
      id: `${event.aggregate}:${event.entityId}`,
      aggregate: event.aggregate,
      op: event.op,
      payload: event.record,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: event.remoteUpdatedAt,
      insertedAt: event.insertedAt,
    }));
  }

  async function readEncrypted(dekVersion?: number): Promise<EncryptedSyncChange[]> {
    return adapter.readEncrypted({ dekVersion });
  }

  async function rotateCiphertext(params: {
    oldDek: string; oldVersion: number; newDek: string; newVersion: number; onProgress?: ReEncryptProgress;
  }): Promise<number> {
    const rows = await adapter.readEncrypted({ dekVersion: params.oldVersion });
    await params.onProgress?.(0, rows.length);
    let converted = 0;
    for (let index = 0; index < rows.length; index += 100) {
      const output: EncryptedSyncLogRow[] = [];
      for (const row of rows.slice(index, index + 100)) {
        const envelope = await decryptRecord<SyncEnvelope>(params.oldDek, row.ciphertext, row.iv);
        const decoded = canonicalSyncChange.decode({
          sourceId: row.id,
          envelope,
          protocolVersion: row.protocolVersion,
          schemaVersion: row.schemaVersion,
          encryptionVersion: row.encryptionVersion,
        });
        if (!decoded.accepted) throw new Error(`Encrypted sync row ${row.id} was rejected: ${decoded.reason}.`);
        const encrypted = await encryptRecord(params.newDek, canonicalSyncChange.envelope(
          decoded.change.aggregate,
          decoded.change.op,
          decoded.change.record,
        ));
        output.push({ ...row, ...encrypted, dekVersion: params.newVersion, encryptionVersion: ENCRYPTION_FORMAT_VERSION });
      }
      await adapter.writeEncrypted(output);
      converted += output.length;
      await params.onProgress?.(converted, rows.length);
    }
    return converted;
  }

  return {
    watch: adapter.watch.bind(adapter),
    pullPlain,
    pullEncrypted,
    publishOutbox,
    publishSteadyStateOutbox,
    createProgressReporter,
    heartbeat: (migration: E2EEMigrationState) => heartbeatMigrationProgress(migration),
    publishPlain,
    publishEncrypted,
    readPlain,
    readEncrypted,
    removePlain: async (ids?: string[]) => ({ deleted: await adapter.deletePlain(ids) }),
    removeEncrypted: async (ids?: string[]) => ({ deleted: await adapter.deleteEncrypted(ids) }),
    rotateCiphertext,

    async copyEncryptedThenRemovePlain(options: {
      changes: EncryptedSyncChange[];
      migration: E2EEMigrationState;
    }) {
      const source = await readPlain();
      await transitionGuard.checkpoint(options.migration, 'transferring');
      const pushed = await publishEncrypted(options.changes);
      const destination = new Map(
        (await readEncrypted()).map((change) => [change.id, change.dekVersion] as const),
      );
      const expected = new Map(options.changes.map((change) => [change.id, change.dekVersion] as const));
      const missing = source.filter((change) => {
        const expectedVersion = expected.get(change.id);
        return expectedVersion === undefined || destination.get(change.id) !== expectedVersion;
      });
      if (missing.length) throw new Error(`Encrypted destination is missing ${missing.length} source change(s).`);
      await transitionGuard.checkpoint(options.migration, 'verifying');
      await transitionGuard.assertOwnership(options.migration);
      await adapter.deleteObservedPlain(source.map((change) => ({
        id: change.id,
        createdAt: change.createdAt,
        insertedAt: change.insertedAt ?? change.createdAt,
      })));
      if ((await readPlain()).length) throw new Error('Plaintext sync sources remain after encrypted transfer.');
      return pushed;
    },

    async copyPlainThenRemoveEncrypted(options: {
      changes: PlainSyncChange[];
      migration: E2EEMigrationState;
    }) {
      const source = await readEncrypted();
      await transitionGuard.checkpoint(options.migration, 'transferring');
      const pushed = await publishPlain(options.changes);
      const destinationIds = new Set((await readPlain()).map((change) => change.id));
      const missing = source.filter((change) => !destinationIds.has(change.id));
      if (missing.length) throw new Error(`Plaintext destination is missing ${missing.length} source change(s).`);
      await transitionGuard.checkpoint(options.migration, 'verifying');
      await transitionGuard.assertOwnership(options.migration);
      const deleted = await adapter.deleteObservedEncrypted(source.map((change) => ({
        id: change.id,
        createdAt: change.createdAt,
        insertedAt: change.insertedAt ?? change.createdAt,
      })));
      if ((await readEncrypted()).length) throw new Error('Encrypted sync sources remain after plaintext transfer.');
      return { pushed: pushed.pushed, deleted };
    },
  };
}

export const remoteSyncLogTransfer = createRemoteSyncLogTransfer(supabaseSyncLogAdapter, {
  async clearPublished(rows) {
    await db.transaction('rw', db.outbox, async () => {
      for (const row of rows) {
        const current = await db.outbox.get(row.id);
        if (current?.rev === row.rev) await db.outbox.delete(row.id);
      }
    });
  },
}, productionTransitionGuard);
export type RemoteSyncLogTransfer = ReturnType<typeof createRemoteSyncLogTransfer>;

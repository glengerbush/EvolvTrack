import { DB_SCHEMA_VERSION, db } from '$lib/db/schema';
import { supabase } from '$lib/auth/supabase';
import { lastSynced } from '$lib/stores/syncStore';
import { applyRemoteChange, getProfile, getProfileSyncMode } from '$lib/domain/repo';
import { requireAuthenticatedUser } from '$lib/sync/account-state';
import { getSessionKey } from '$lib/sync/session-key';
import { getPullCursor, setPullCursor } from '$lib/sync/pull-cursor';
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import { ENCRYPTION_FORMAT_VERSION, decryptRecord, encryptRecord } from '$lib/crypto/e2ee';
import type { OutboxEntry, SyncAggregate } from '$lib/domain/types';

type PushEncryptedChangesOptions = {
  allowMigrating?: boolean;
};

export type PlainSyncChange = {
  id: string;
  aggregate: SyncAggregate;
  op: 'upsert' | 'delete';
  payload: unknown;
  protocolVersion: number;
  schemaVersion: number;
  createdAt: string;
};

export type EncryptedSyncChange = {
  id: string;
  ciphertext: string;
  iv: string;
  protocolVersion: number;
  encryptionVersion: number;
  schemaVersion: number;
  createdAt: string;
};

export type PushOutboxResult = {
  pushed: number;
  /** Set when the push was intentionally a no-op rather than a success. */
  skipped?: 'migration-in-progress' | 'locked';
};

/**
 * Push every pending local change in the outbox to the cloud. This is the
 * steady-state push path (the E2EE migration owns its own push functions).
 *
 * The destination is decided strictly by sync mode — `plain` payloads go to
 * `sync_changes_plain`, `e2ee` payloads are encrypted here and go to
 * `sync_changes_encrypted`. The two never cross. Steady-state sync pauses entirely while
 * an E2EE migration is in progress, and encrypted mode pauses if the session
 * is locked (no passphrase in memory). Outbox rows are removed only after a
 * confirmed upsert, and only if they haven't been re-edited since (the `rev`
 * check), so nothing is lost to a concurrent mutation.
 *
 * Not self-guarded against concurrent invocation — call it only via the sync
 * orchestrator, which serializes pull-then-push and prevents overlap.
 */
export async function pushOutbox(): Promise<PushOutboxResult> {
  const profile = await getProfile();
  const syncMode = getProfileSyncMode(profile);

  if (
    syncMode === 'migrating_to_e2ee' ||
    syncMode === 'migrating_to_plain' ||
    syncMode === 'rotating_e2ee_key'
  ) {
    return { pushed: 0, skipped: 'migration-in-progress' };
  }

  const rows = await db.outbox.orderBy('updatedAt').toArray();
  if (!rows.length) return { pushed: 0 };

  const user = await requireAuthenticatedUser();

  if (syncMode === 'e2ee') {
    const sessionKey = getSessionKey();
    if (!sessionKey) return { pushed: 0, skipped: 'locked' };
    await pushEncryptedOutbox(rows, user.id, sessionKey);
  } else {
    await pushPlainOutbox(rows, user.id);
  }

  await clearPushedOutboxRows(rows);
  return { pushed: rows.length };
}

/**
 * The wire shape of an outbox change, before plain/encrypted routing. For a
 * delete, `record` is null — the envelope itself is the tombstone.
 */
function syncEnvelope(row: OutboxEntry) {
  return { aggregate: row.aggregate, op: row.op, record: row.payload };
}

async function pushPlainOutbox(rows: OutboxEntry[], userId: string): Promise<void> {
  const payload = rows.map((row) => ({
    id: row.id,
    user_id: userId,
    aggregate: row.aggregate,
    op: row.op,
    payload: syncEnvelope(row),
    protocol_version: SYNC_PROTOCOL_VERSION,
    schema_version: DB_SCHEMA_VERSION,
    created_at: row.updatedAt,
  }));

  const { error } = await supabase
    .from('sync_changes_plain')
    .upsert(payload, { onConflict: 'user_id,id' });
  if (error) throw error;
}

async function pushEncryptedOutbox(
  rows: OutboxEntry[],
  userId: string,
  sessionKey: string,
): Promise<void> {
  // `aggregate` and `op` are intentionally NOT in the wire payload — they
  // live inside the encrypted envelope (see `syncEnvelope`) so the server
  // cannot tell what kind of record this is or whether it's an upsert vs a
  // delete. The matching server column was dropped in migration
  // 20260528010000_strip_encrypted_metadata.sql.
  const payload = [];
  for (const row of rows) {
    const encrypted = await encryptRecord(sessionKey, syncEnvelope(row));
    payload.push({
      id: row.id,
      user_id: userId,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      protocol_version: SYNC_PROTOCOL_VERSION,
      encryption_version: ENCRYPTION_FORMAT_VERSION,
      schema_version: DB_SCHEMA_VERSION,
      created_at: row.updatedAt,
    });
  }

  const { error } = await supabase
    .from('sync_changes_encrypted')
    .upsert(payload, { onConflict: 'user_id,id' });
  if (error) throw error;
}

async function clearPushedOutboxRows(pushed: OutboxEntry[]): Promise<void> {
  // Delete only rows still carrying the `rev` we pushed. A mutation that
  // landed mid-push replaces `rev`, and that newer change must survive to be
  // picked up by the next push.
  await db.transaction('rw', db.outbox, async () => {
    for (const row of pushed) {
      const current = await db.outbox.get(row.id);
      if (current && current.rev === row.rev) {
        await db.outbox.delete(row.id);
      }
    }
  });
}

export type PullResult = {
  /** Rows fetched from the cloud since the last cursor. */
  fetched: number;
  /** Of those, how many actually changed local state (the rest lost LWW). */
  applied: number;
  skipped?: 'migration-in-progress' | 'locked';
};

/**
 * The decoded form of a remote event, ready to hand to `applyRemoteChange`,
 * plus the `insertedAt` cursor value used to advance our high-water mark.
 */
type PulledEvent = {
  aggregate: SyncAggregate;
  entityId: string;
  op: 'upsert' | 'delete';
  record: unknown;
  remoteUpdatedAt: string;
  insertedAt: string;
};

type SyncEnvelopeShape = {
  aggregate?: SyncAggregate;
  op?: 'upsert' | 'delete';
  record?: unknown;
};

function entityIdFromRowId(rowId: string): string {
  // Row ids are `${aggregate}:${entityId}`; aggregates never contain a colon.
  const idx = rowId.indexOf(':');
  return idx >= 0 ? rowId.slice(idx + 1) : rowId;
}

/**
 * Pull remote events newer than the local cursor and apply them
 * last-writer-wins. Incremental by the server-set `inserted_at` column. Reads
 * from `sync_changes_plain` or `sync_changes_encrypted` strictly per sync mode; pauses
 * during an E2EE migration, and (in encrypted mode) while the session is
 * locked. The cursor only advances after every fetched event has been applied.
 *
 * Not self-guarded against concurrent invocation — call it only via the sync
 * orchestrator, which serializes pull-then-push and prevents overlap.
 */
export async function pullAndApply(): Promise<PullResult> {
  const profile = await getProfile();
  const syncMode = getProfileSyncMode(profile);

  if (
    syncMode === 'migrating_to_e2ee' ||
    syncMode === 'migrating_to_plain' ||
    syncMode === 'rotating_e2ee_key'
  ) {
    // During rotation the server holds old-DEK rows that the local (new) DEK
    // can't decrypt — pause pull until rotation finishes.
    return { fetched: 0, applied: 0, skipped: 'migration-in-progress' };
  }

  const user = await requireAuthenticatedUser();
  const cursor = getPullCursor();

  let events: PulledEvent[];
  if (syncMode === 'e2ee') {
    const sessionKey = getSessionKey();
    if (!sessionKey) return { fetched: 0, applied: 0, skipped: 'locked' };
    events = await pullEncrypted(user.id, cursor, sessionKey);
  } else {
    events = await pullPlain(user.id, cursor);
  }

  if (!events.length) return { fetched: 0, applied: 0 };

  let applied = 0;
  for (const event of events) {
    if (await applyRemoteChange(event)) applied += 1;
  }

  // Events arrive ordered by `inserted_at` ascending, so the last one is the
  // new high-water mark.
  setPullCursor(events[events.length - 1].insertedAt);
  return { fetched: events.length, applied };
}

async function pullPlain(userId: string, cursor: string | null): Promise<PulledEvent[]> {
  let query = supabase
    .from('sync_changes_plain')
    .select('id,aggregate,op,payload,created_at,inserted_at')
    .eq('user_id', userId)
    .order('inserted_at', { ascending: true });
  if (cursor) query = query.gt('inserted_at', cursor);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => {
    const envelope = (row.payload ?? {}) as SyncEnvelopeShape;
    return {
      aggregate: (envelope.aggregate ?? row.aggregate) as SyncAggregate,
      entityId: entityIdFromRowId(row.id),
      op: (envelope.op ?? row.op) as 'upsert' | 'delete',
      record: envelope.record ?? null,
      remoteUpdatedAt: row.created_at,
      insertedAt: row.inserted_at,
    };
  });
}

async function pullEncrypted(
  userId: string,
  cursor: string | null,
  sessionKey: string,
): Promise<PulledEvent[]> {
  let query = supabase
    .from('sync_changes_encrypted')
    .select('id,ciphertext,iv,created_at,inserted_at')
    .eq('user_id', userId)
    .order('inserted_at', { ascending: true });
  if (cursor) query = query.gt('inserted_at', cursor);

  const { data, error } = await query;
  if (error) throw error;

  const events: PulledEvent[] = [];
  for (const row of data ?? []) {
    let envelope: SyncEnvelopeShape;
    try {
      envelope = await decryptRecord<SyncEnvelopeShape>(sessionKey, row.ciphertext, row.iv);
    } catch (cause) {
      // Re-throw with the row id so the orchestrator's sync-cycle log makes it
      // obvious which row tripped the crypto error (otherwise the message is
      // just "operation failed for an operation-specific reason" with no clue
      // which record is unreadable).
      const message = (cause as Error).message ?? String(cause);
      throw new Error(`Failed to decrypt encrypted sync row ${row.id}: ${message}`);
    }
    // `aggregate` and `op` come exclusively from the encrypted envelope now;
    // the server columns were dropped to stop leaking per-aggregate volume.
    // An envelope missing either field is a corrupted/forged row — skip it
    // rather than guess at what the row was.
    if (!envelope.aggregate || !envelope.op) {
      throw new Error(`Encrypted sync row ${row.id} is missing aggregate/op in its envelope.`);
    }
    events.push({
      aggregate: envelope.aggregate,
      entityId: entityIdFromRowId(row.id),
      op: envelope.op,
      record: envelope.record ?? null,
      remoteUpdatedAt: row.created_at,
      insertedAt: row.inserted_at,
    });
  }
  return events;
}

export async function pushEncryptedChanges(options: PushEncryptedChangesOptions = {}) {
  const profile = await getProfile();
  const syncMode = getProfileSyncMode(profile);

  if (syncMode === 'plain') {
    throw new Error('Enable E2EE before pushing encrypted sync changes.');
  }

  if (syncMode === 'migrating_to_e2ee' && !options.allowMigrating) {
    throw new Error('E2EE migration is in progress. Resume the migration before normal sync.');
  }

  if (syncMode === 'migrating_to_plain') {
    throw new Error('E2EE disable is in progress. Finish or resume it before encrypted sync.');
  }

  if (syncMode === 'rotating_e2ee_key' && !options.allowMigrating) {
    throw new Error('Key rotation is in progress. Finish or resume it before encrypted sync.');
  }

  const user = await requireAuthenticatedUser();
  const rows = await db.migrationBackfill.orderBy('createdAt').toArray();
  if (!rows.length) return { pushed: 0 };

  // `aggregate` and `op` stay inside the encrypted payload — see
  // pushEncryptedOutbox for the rationale.
  const payload = rows.map((row) => ({
    id: row.id,
    user_id: user.id,
    ciphertext: row.payloadCiphertext,
    iv: row.payloadIv,
    protocol_version: row.protocolVersion,
    encryption_version: row.encryptionVersion,
    schema_version: row.schemaVersion,
    created_at: row.createdAt
  }));

  const { error } = await supabase
    .from('sync_changes_encrypted')
    .upsert(payload, { onConflict: 'user_id,id' });
  if (error) throw error;
  lastSynced.record();
  return { pushed: payload.length };
}

export async function pushPlainChanges(changes: PlainSyncChange[]) {
  const user = await requireAuthenticatedUser();
  if (!changes.length) return { pushed: 0 };

  const payload = changes.map((change) => ({
    id: change.id,
    user_id: user.id,
    aggregate: change.aggregate,
    op: change.op,
    payload: change.payload,
    protocol_version: change.protocolVersion,
    schema_version: change.schemaVersion,
    created_at: change.createdAt,
  }));

  const { error } = await supabase
    .from('sync_changes_plain')
    .upsert(payload, { onConflict: 'user_id,id' });
  if (error) throw error;
  lastSynced.record();
  return { pushed: payload.length };
}

export async function deleteRemoteEncryptedChanges(ids?: string[]) {
  const user = await requireAuthenticatedUser();
  let deleted = ids?.length ?? 0;
  let query = supabase.from('sync_changes_encrypted').delete().eq('user_id', user.id);

  if (ids?.length) {
    query = query.in('id', ids);
  }

  const { error } = await query;
  if (error) throw error;
  lastSynced.record();
  return { deleted };
}

/**
 * Delete plaintext sync rows for the current user. Mirrors
 * `deleteRemoteEncryptedChanges`: with `ids` it deletes only those rows, with
 * no argument it clears the whole `sync_changes_plain` table for the user.
 *
 * Called when an enable migration completes — once the encrypted copies are
 * safely on the server, the plaintext originals must go, or "E2EE on" would
 * still leave readable PHI server-side.
 */
export async function deleteRemotePlainChanges(ids?: string[]) {
  const user = await requireAuthenticatedUser();
  const deleted = ids?.length ?? 0;
  let query = supabase.from('sync_changes_plain').delete().eq('user_id', user.id);

  if (ids?.length) {
    query = query.in('id', ids);
  }

  const { error } = await query;
  if (error) throw error;
  lastSynced.record();
  return { deleted };
}

/**
 * Pull *every* remote row (plain, plus encrypted when a key is available) and
 * apply it locally last-writer-wins, ignoring the cursor.
 *
 * This is the recovery primitive for an interrupted enable migration: before
 * we re-encrypt local records and then delete the plaintext table, we must
 * absorb anything that exists only on the server — e.g. rows another device
 * pushed to `sync_changes_plain`, or encrypted rows a prior partial run of
 * this migration already pushed. Without this, finishing the migration (which
 * deletes the plaintext rows) could drop server-only data.
 *
 * Deliberately ungated: the steady-state `pullAndApply` pauses during a
 * migration, but this is invoked *by* the migration to drive it forward.
 */
export async function pullSnapshotForMigration(
  sessionKey: string | null,
): Promise<{ fetched: number; applied: number }> {
  const user = await requireAuthenticatedUser();

  const events = await pullPlain(user.id, null);
  if (sessionKey) {
    events.push(...(await pullEncrypted(user.id, null, sessionKey)));
  }

  let applied = 0;
  for (const event of events) {
    if (await applyRemoteChange(event)) applied += 1;
  }
  return { fetched: events.length, applied };
}

export async function fetchRemoteEncryptedChanges(): Promise<EncryptedSyncChange[]> {
  const user = await requireAuthenticatedUser();
  const { data, error } = await supabase
    .from('sync_changes_encrypted')
    .select('id,ciphertext,iv,protocol_version,encryption_version,schema_version,created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    protocolVersion: row.protocol_version,
    encryptionVersion: row.encryption_version,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  }));
}

import { DB_SCHEMA_VERSION, db } from '$lib/db/schema';
import { supabase } from '$lib/auth/supabase';
import { applyRemoteChange, getProfile, getProfileSyncMode } from '$lib/domain/repo';
import { fetchRemoteSyncAccount, requireAuthenticatedUser } from '$lib/sync/account-state';
import { getSessionKey } from '$lib/sync/session-key';
import { getPullCursor, setPullCursor } from '$lib/sync/pull-cursor';
import { SYNC_PROTOCOL_VERSION } from '$lib/sync/protocol';
import { ENCRYPTION_FORMAT_VERSION, decryptRecord, encryptRecord } from '$lib/crypto/e2ee';
import { getLocalWrappedKeys } from '$lib/sync/wrapped-keys';
import type { OutboxEntry, SyncAggregate, SyncMode } from '$lib/domain/types';

/** Stay below Supabase's default 1,000-row Data API cap and page explicitly.
 * Migration/recovery reads must be exhaustive: truncating one before deleting
 * or rewriting its source table can permanently lose remote-only records. */
const REMOTE_PAGE_SIZE = 500;

type PageResult<T> = { data: T[] | null; error: unknown };

type PlainRemoteRow = {
  id: string;
  aggregate: SyncAggregate;
  op: 'upsert' | 'delete';
  payload: unknown;
  created_at: string;
  inserted_at: string;
};

type EncryptedPullRow = {
  id: string;
  ciphertext: string;
  iv: string;
  created_at: string;
  inserted_at: string;
};

type EncryptedStoredRow = {
  id: string;
  ciphertext: string;
  iv: string;
  protocol_version: number;
  encryption_version: number;
  schema_version: number;
  created_at: string;
};

type ReEncryptionSourceRow = Omit<EncryptedStoredRow, 'encryption_version'>;

async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += REMOTE_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + REMOTE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    all.push(...page);
    if (page.length < REMOTE_PAGE_SIZE) return all;
  }
}

/**
 * The DEK version currently in force, taken from the local key bundle (defaults
 * to 1 pre-versioning). Encrypted rows are tagged with this so a key rotation
 * can tell what's already been re-encrypted, and pulls filter on it so an
 * orphaned row under a different key (e.g. a crashed rotation) never reaches —
 * and crashes — the decrypt path.
 */
async function activeDekVersion(): Promise<number> {
  return (await getLocalWrappedKeys())?.dekVersion ?? 1;
}

/** True for the three transient modes an account passes through during an E2EE
 *  change. Steady-state pull/push pause for all of them. */
function isMigratingSyncMode(mode: SyncMode): boolean {
  return (
    mode === 'migrating_to_e2ee' ||
    mode === 'migrating_to_plain' ||
    mode === 'rotating_e2ee_key'
  );
}

/** Postgres SQLSTATE 42501 (insufficient_privilege) — what PostgREST returns
 *  when a row fails a RLS `WITH CHECK`. On the sync-change tables the only
 *  WITH CHECK that can trip is the sync_mode / license guard. */
function isRowLevelSecurityRejection(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '42501'
  );
}

/**
 * Confirm a push rejection is the benign "another device started an E2EE change
 * before this one caught up" case, rather than something we must surface (a
 * lapsed license trips the same 42501). Returns true only when the server's
 * canonical mode is mid-transition. Best-effort: if the confirmation fetch
 * itself fails, return false so the original rejection is rethrown rather than
 * silently swallowed.
 */
async function serverIsMidTransition(): Promise<boolean> {
  try {
    const account = await fetchRemoteSyncAccount();
    return account != null && isMigratingSyncMode(account.syncMode);
  } catch {
    return false;
  }
}

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
  /** Set when the push was intentionally a no-op rather than a success.
   *  `mode-rejected` is the server refusing a write because an E2EE change
   *  started on another device after this cycle's reconcile — benign, retried. */
  skipped?: 'migration-in-progress' | 'locked' | 'mode-rejected';
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

  if (isMigratingSyncMode(syncMode)) {
    return { pushed: 0, skipped: 'migration-in-progress' };
  }

  const rows = await db.outbox.orderBy('updatedAt').toArray();
  if (!rows.length) return { pushed: 0 };

  const user = await requireAuthenticatedUser();

  try {
    if (syncMode === 'e2ee') {
      const sessionKey = getSessionKey();
      if (!sessionKey) return { pushed: 0, skipped: 'locked' };
      await pushEncryptedOutbox(rows, user.id, sessionKey);
    } else {
      await pushPlainOutbox(rows, user.id);
    }
  } catch (error) {
    // A non-owner device can race an E2EE change another device just started:
    // this cycle's reconcile saw the pre-change mode, so we pushed in the now-
    // stale mode and the server's sync_mode WITH CHECK refused it. Expected and
    // benign — leave the outbox intact (these edits re-push, re-encrypted under
    // the new key, once the change finishes) and report a skip rather than an
    // error. The next reconcile adopts the migrating mode and the gate/modal
    // take over. A 42501 that ISN'T a transition (e.g. a lapsed license) still
    // throws, so real problems aren't swallowed.
    if (isRowLevelSecurityRejection(error) && (await serverIsMidTransition())) {
      return { pushed: 0, skipped: 'mode-rejected' };
    }
    throw error;
  }

  await clearPushedOutboxRows(rows);
  return { pushed: rows.length };
}

/**
 * The wire shape of a sync change, before plain/encrypted routing. For a
 * delete, `record` is null — the envelope itself is the tombstone. Both the
 * steady-state push and the migration push must produce this exact shape:
 * `pullPlain` / `pullEncrypted` read `payload.record` back out, so a row
 * written without the wrapper decodes to a null record (see the guard in
 * `applyRemoteChange`).
 */
function plainWireEnvelope(aggregate: SyncAggregate, op: 'upsert' | 'delete', record: unknown) {
  return { aggregate, op, record };
}

function syncEnvelope(row: OutboxEntry) {
  return plainWireEnvelope(row.aggregate, row.op, row.payload);
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
  const dekVersion = await activeDekVersion();
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
      dek_version: dekVersion,
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

  if (isMigratingSyncMode(syncMode)) {
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
  const rows = await fetchAllPages<PlainRemoteRow>((from, to) => {
    let query = supabase
      .from('sync_changes_plain')
      .select('id,aggregate,op,payload,created_at,inserted_at')
      .eq('user_id', userId)
      .order('inserted_at', { ascending: true })
      .order('id', { ascending: true });
    if (cursor) query = query.gt('inserted_at', cursor);
    return query.range(from, to);
  });

  return rows.map((row) => {
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
  // Only pull rows under the DEK we actually hold. A row under a different
  // version (an orphan from an interrupted rotation, say) is undecryptable
  // anyway, so excluding it here keeps one bad row from crashing the whole pull.
  const dekVersion = await activeDekVersion();
  const rows = await fetchAllPages<EncryptedPullRow>((from, to) => {
    let query = supabase
      .from('sync_changes_encrypted')
      .select('id,ciphertext,iv,created_at,inserted_at')
      .eq('user_id', userId)
      .eq('dek_version', dekVersion)
      .order('inserted_at', { ascending: true })
      .order('id', { ascending: true });
    if (cursor) query = query.gt('inserted_at', cursor);
    return query.range(from, to);
  });

  const events: PulledEvent[] = [];
  for (const row of rows) {
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
  // pushEncryptedOutbox for the rationale. Tag with the active DEK version (the
  // bundle these backfill rows were encrypted under).
  const dekVersion = await activeDekVersion();
  const payload = rows.map((row) => ({
    id: row.id,
    user_id: user.id,
    ciphertext: row.payloadCiphertext,
    iv: row.payloadIv,
    protocol_version: row.protocolVersion,
    encryption_version: row.encryptionVersion,
    dek_version: dekVersion,
    schema_version: row.schemaVersion,
    created_at: row.createdAt
  }));

  const { error } = await supabase
    .from('sync_changes_encrypted')
    .upsert(payload, { onConflict: 'user_id,id' });
  if (error) throw error;
  return { pushed: payload.length };
}

export async function pushPlainChanges(changes: PlainSyncChange[]) {
  const user = await requireAuthenticatedUser();
  if (!changes.length) return { pushed: 0 };

  // Collapse duplicate ids, keeping the newest by `createdAt` (the LWW clock).
  // Two encrypted rows can map to the same canonical plain id when one entity
  // exists both as an enable-backfill row and a steady-state row; a Postgres
  // upsert rejects a batch that touches the same (user_id, id) twice
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  const deduped = [...new Map(
    [...changes]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((change) => [change.id, change] as const),
  ).values()];

  const payload = deduped.map((change) => ({
    id: change.id,
    user_id: user.id,
    aggregate: change.aggregate,
    op: change.op,
    // Wrap in the same envelope `pushPlainOutbox` uses so `pullPlain` can read
    // `record` back out. Storing the bare record here was the disable-migration
    // bug that left every converted row decoding to a null upsert.
    payload: plainWireEnvelope(change.aggregate, change.op, change.payload),
    protocol_version: change.protocolVersion,
    schema_version: change.schemaVersion,
    created_at: change.createdAt,
  }));

  const { error } = await supabase
    .from('sync_changes_plain')
    .upsert(payload, { onConflict: 'user_id,id' });
  if (error) throw error;
  return { pushed: payload.length };
}

export async function deleteRemoteEncryptedChanges(ids?: string[]) {
  const user = await requireAuthenticatedUser();
  // `count: 'exact'` so a no-id sweep (delete every row for the user) still
  // reports how many it removed — the disable migration uses this to report the
  // number of encrypted rows discarded, including orphans under a stale DEK
  // version. Falls back to the id-list length when the backend omits a count.
  let query = supabase
    .from('sync_changes_encrypted')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);

  if (ids?.length) {
    query = query.in('id', ids);
  }

  const { error, count } = await query;
  if (error) throw error;
  return { deleted: count ?? ids?.length ?? 0 };
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

/**
 * Fetch every row currently in `sync_changes_plain` as canonical
 * `PlainSyncChange`s (id `${aggregate}:${entityId}`, the record as payload, the
 * row's `created_at` as the LWW clock).
 *
 * The disable migration uses this to fold the plaintext table into its
 * conversion set: a device may have pushed a plain row before it learned a
 * disable was underway (the account sits in `migrating_to_plain`, which RLS lets
 * plain writes through). Concatenated with the encrypted-derived changes and run
 * through `pushPlainChanges` — whose id-dedupe keeps the newest `createdAt` — so
 * a newer plain edit is never clobbered by an older encrypted-derived one.
 */
export async function fetchRemotePlainChanges(): Promise<PlainSyncChange[]> {
  const user = await requireAuthenticatedUser();
  const events = await pullPlain(user.id, null);
  return events.map((event) => ({
    id: `${event.aggregate}:${event.entityId}`,
    aggregate: event.aggregate,
    op: event.op,
    payload: event.record,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    schemaVersion: DB_SCHEMA_VERSION,
    createdAt: event.remoteUpdatedAt,
  }));
}

export async function fetchRemoteEncryptedChanges(dekVersion?: number): Promise<EncryptedSyncChange[]> {
  const user = await requireAuthenticatedUser();
  const rows = await fetchAllPages<EncryptedStoredRow>((from, to) => {
    let query = supabase
      .from('sync_changes_encrypted')
      .select('id,ciphertext,iv,protocol_version,encryption_version,schema_version,created_at')
      .eq('user_id', user.id);
    if (dekVersion !== undefined) query = query.eq('dek_version', dekVersion);
    return query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to);
  });

  return rows.map((row) => ({
    id: row.id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    protocolVersion: row.protocol_version,
    encryptionVersion: row.encryption_version,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  }));
}

export type ReEncryptProgress = (converted: number, total: number) => Promise<void> | void;

/**
 * Re-encrypt the server's encrypted rows from one DEK to another, in place.
 *
 * The heart of a crash-safe key rotation: it reads the rows still tagged with
 * the OLD `dek_version`, decrypts each with `oldDek`, re-encrypts with `newDek`,
 * and upserts it back under the SAME id with the NEW `dek_version`. Because it
 * works from the server's ciphertext (not local plaintext) it needs no local
 * data, so it runs on a fresh device. Because it only ever reads old-version
 * rows and flips them in place, it's idempotent: a crashed run just re-processes
 * whatever is still on the old version. Returns the number of rows converted.
 */
export async function reEncryptServerRows(params: {
  oldDek: string;
  oldVersion: number;
  newDek: string;
  newVersion: number;
  onProgress?: ReEncryptProgress;
}): Promise<number> {
  const { oldDek, oldVersion, newDek, newVersion, onProgress } = params;
  const user = await requireAuthenticatedUser();

  const rows = await fetchAllPages<ReEncryptionSourceRow>((from, to) =>
    supabase
      .from('sync_changes_encrypted')
      .select('id,ciphertext,iv,protocol_version,schema_version,created_at')
      .eq('user_id', user.id)
      .eq('dek_version', oldVersion)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  const total = rows.length;
  if (onProgress) await onProgress(0, total);
  if (total === 0) return 0;

  let converted = 0;
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const payload = [];
    for (const row of batch) {
      // The envelope ({ aggregate, op, record }) is preserved verbatim — we only
      // change the key it's sealed under.
      const envelope = await decryptRecord<unknown>(oldDek, row.ciphertext, row.iv);
      const encrypted = await encryptRecord(newDek, envelope);
      payload.push({
        id: row.id,
        user_id: user.id,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        protocol_version: row.protocol_version,
        encryption_version: ENCRYPTION_FORMAT_VERSION,
        dek_version: newVersion,
        schema_version: row.schema_version,
        created_at: row.created_at,
      });
    }
    const { error: upsertError } = await supabase
      .from('sync_changes_encrypted')
      .upsert(payload, { onConflict: 'user_id,id' });
    if (upsertError) throw upsertError;
    converted += batch.length;
    if (onProgress) await onProgress(converted, total);
  }

  return converted;
}

import { db } from '$lib/db/schema';
import { applyRemoteChange, getProfile, getProfileSyncMode } from '$lib/domain/repo';
import type { SyncMode } from '$lib/domain/types';
import type { PlainSyncChange } from '$lib/sync/canonical-sync-change';
import { deviceEncryptionState } from '$lib/sync/device-encryption-state';
import {
  remoteSyncLogTransfer,
  type EncryptedSyncChange,
  type ReEncryptProgress,
  type RemotePulledChange,
} from '$lib/sync/remote-sync-log-transfer';

export type { PlainSyncChange } from '$lib/sync/canonical-sync-change';

/**
 * The DEK version currently in force, taken from the local key bundle (defaults
 * to 1 pre-versioning). Encrypted rows are tagged with this so a key rotation
 * can tell what's already been re-encrypted, and pulls filter on it so an
 * orphaned row under a different key (e.g. a crashed rotation) never reaches —
 * and crashes — the decrypt path.
 */
async function activeDekVersion(): Promise<number> {
  return deviceEncryptionState.activeDekVersion();
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

type PushEncryptedChangesOptions = {
  allowMigrating?: boolean;
};

export type { EncryptedSyncChange, ReEncryptProgress } from '$lib/sync/remote-sync-log-transfer';

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

  let transfer;
  try {
    if (syncMode === 'e2ee') {
      const sessionKey = deviceEncryptionState.getSessionKey();
      if (!sessionKey) return { pushed: 0, skipped: 'locked' };
      transfer = await remoteSyncLogTransfer.publishSteadyStateOutbox({
        rows,
        syncMode,
        sessionKey,
        dekVersion: await activeDekVersion(),
      });
    } else {
      transfer = await remoteSyncLogTransfer.publishSteadyStateOutbox({
        rows,
        syncMode: 'plain',
        dekVersion: 1,
      });
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
    throw error;
  }

  if (transfer.modeRejected) return { pushed: 0, skipped: 'mode-rejected' };

  return { pushed: rows.length };
}

export type PullResult = {
  /** Rows fetched from the cloud since the last cursor. */
  fetched: number;
  /** Of those, how many actually changed local state (the rest lost LWW). */
  applied: number;
  skipped?: 'migration-in-progress' | 'locked';
};

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

  const cursor = deviceEncryptionState.getPullCursor();

  let events: RemotePulledChange[];
  if (syncMode === 'e2ee') {
    const sessionKey = deviceEncryptionState.getSessionKey();
    if (!sessionKey) return { fetched: 0, applied: 0, skipped: 'locked' };
    events = await remoteSyncLogTransfer.pullEncrypted(cursor, sessionKey, await activeDekVersion());
  } else {
    events = await remoteSyncLogTransfer.pullPlain(cursor);
  }

  if (!events.length) return { fetched: 0, applied: 0 };

  let applied = 0;
  for (const event of events) {
    if (await applyRemoteChange(event)) applied += 1;
  }

  // Events arrive ordered by `inserted_at` ascending, so the last one is the
  // new high-water mark.
  deviceEncryptionState.setPullCursor(events[events.length - 1].insertedAt);
  return { fetched: events.length, applied };
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

  const rows = await db.migrationBackfill.orderBy('createdAt').toArray();
  if (!rows.length) return { pushed: 0 };

  // `aggregate` and `op` stay inside the encrypted payload — see
  // pushEncryptedOutbox for the rationale. Tag with the active DEK version (the
  // bundle these backfill rows were encrypted under).
  const dekVersion = await activeDekVersion();
  const payload: EncryptedSyncChange[] = rows.map((row) => ({
    id: row.id,
    ciphertext: row.payloadCiphertext,
    iv: row.payloadIv,
    protocolVersion: row.protocolVersion,
    encryptionVersion: row.encryptionVersion,
    dekVersion,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
  }));
  return remoteSyncLogTransfer.publishEncrypted(payload);
}

export async function pushPlainChanges(changes: PlainSyncChange[]) {
  return remoteSyncLogTransfer.publishPlain(changes);
}

export async function deleteRemoteEncryptedChanges(ids?: string[]) {
  return remoteSyncLogTransfer.removeEncrypted(ids);
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
  return remoteSyncLogTransfer.removePlain(ids);
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
  const events = await remoteSyncLogTransfer.pullPlain(null, true);
  if (sessionKey) {
    events.push(...(await remoteSyncLogTransfer.pullEncrypted(null, sessionKey, await activeDekVersion())));
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
  return remoteSyncLogTransfer.readPlain();
}

export async function fetchRemoteEncryptedChanges(dekVersion?: number): Promise<EncryptedSyncChange[]> {
  return remoteSyncLogTransfer.readEncrypted(dekVersion);
}

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
  return remoteSyncLogTransfer.rotateCiphertext(params);
}

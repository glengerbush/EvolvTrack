import { nanoid } from 'nanoid';
import { liveQuery, type Table } from 'dexie';
import { db } from '$lib/db/schema';
import type {
  HealthEntry,
  IsoDate,
  IsoDateTime,
  OutboxEntry,
  Prescription,
  ProfileSettings,
  SyncAggregate,
  SyncMode,
} from '$lib/domain/types';
import { canonicalDomain } from '$lib/domain/canonical-domain';
import { localDateKey } from '$lib/utils/dateKeys';
import {
  MERGEABLE_AGGREGATES,
  PROFILE_DEVICE_LOCAL,
  applyPatchWithClears,
  bumpFieldStamps,
  mergeRecord,
  stampAllFields,
  type Mergeable,
} from '$lib/domain/merge';
import {
  DEFAULT_SYMPTOM_OPTIONS,
  generateSymptomColor,
} from '$lib/utils/symptoms';

// Server-anchored, monotonic timestamps so cross-device LWW isn't decided by
// whichever device's wall clock drifts furthest. See `$lib/sync/clock`.
import { now } from '$lib/sync/clock';
export const DEFAULT_SYNC_MODE: SyncMode = 'plain';

// ── Edit gating during an E2EE change ────────────────────────────────────────
// While the account is mid-migration (enable/disable/rotate) no device may make
// data edits: the conversion is a multi-step server operation, and a new edit
// landing in the wrong table (or under a key about to be retired) is what wedges
// it. Steady-state sync is already paused for the duration; this gate closes the
// matching hole at the *write* side so a user edit can't slip in before this
// device's UI has even shown the blocking migration modal.
//
// Enforced inside every Health Entry, Vial, and import transaction before its
// first health-data write. Incoming sync changes do not pass through this
// guard, and profile settings are exempt because transition progress is stored
// there and the profile carries no treatment observations.
//
function isE2EEChangeInProgress(mode: SyncMode): boolean {
  return (
    mode === 'migrating_to_e2ee' ||
    mode === 'migrating_to_plain' ||
    mode === 'rotating_e2ee_key'
  );
}

/** Thrown by a data mutation attempted during an Encryption Transition. */
export class MigrationInProgressError extends Error {
  constructor() {
    super('An encryption change is in progress on your account. Finish it before editing your data.');
    this.name = 'MigrationInProgressError';
  }
}

/** Guard a data (non-profile) edit against the persisted Encryption Transition state. */
async function assertDataEditAllowed(aggregate: SyncAggregate): Promise<void> {
  if (
    aggregate !== 'profile'
    && isE2EEChangeInProgress(getProfileSyncMode(await db.profile.get('profile')))
  ) {
    throw new MigrationInProgressError();
  }
}

// ── Change events ──────────────────────────────────────────────────────────
// Emitted after each health-entry mutation so caches can update incrementally
// instead of re-reading the full table from IndexedDB.

export type HealthDataChange =
  | { action: 'add'; entity: HealthEntry }
  | { action: 'patch'; id: string; patch: Partial<HealthEntry> }
  | { action: 'bulkPatch'; ids: string[]; patch: Partial<HealthEntry> }
  | { action: 'delete'; id: string }
  | { action: 'reset' };

const healthChangeListeners = new Set<(change: HealthDataChange) => void>();

export function onHealthDataChange(listener: (change: HealthDataChange) => void): () => void {
  healthChangeListeners.add(listener);
  return () => healthChangeListeners.delete(listener);
}

export function emitHealthChange(change: HealthDataChange) {
  for (const listener of healthChangeListeners) listener(change);
}

// Fired whenever a local mutation enqueues an outbox entry, so the sync
// orchestrator can debounce a push. Deliberately payload-free — listeners
// just need the nudge. NOT fired for applied remote changes (those bypass the
// outbox), so this can never feed a sync loop.
const outboxChangeListeners = new Set<() => void>();

export function onOutboxChange(listener: () => void): () => void {
  outboxChangeListeners.add(listener);
  return () => outboxChangeListeners.delete(listener);
}

function emitOutboxChange() {
  for (const listener of outboxChangeListeners) listener();
}

export function getProfileSyncMode(profile: ProfileSettings | undefined): SyncMode {
  return profile?.syncMode ?? DEFAULT_SYNC_MODE;
}

// ── Outbox ─────────────────────────────────────────────────────────────────
// Every local mutation enqueues a pending change here, inside the same
// transaction as the entity write, so the push path (Phase 2) has a durable
// queue. One row per entity — repeated edits coalesce.

/**
 * Strip device-local sync bookkeeping from a profile before it leaves the
 * device. `syncMode` and `e2eeMigration` describe *this* device's sync state
 * and must not propagate; `passphraseEnabled` is forced false because the
 * synced copy is, by definition, not the locally-encrypted one.
 */
function toSyncableProfile(profile: ProfileSettings): unknown {
  return canonicalDomain.serializeSyncableProfile(profile);
}

async function writeOutboxChange(
  aggregate: SyncAggregate,
  entityId: string,
  op: 'upsert' | 'delete',
  updatedAt: IsoDateTime,
  payload: unknown,
): Promise<void> {
  await db.outbox.put({
    id: `${aggregate}:${entityId}`,
    aggregate,
    entityId,
    op,
    updatedAt,
    payload,
    enqueuedAt: now(),
    rev: nanoid(),
  });
  // Emitted inside the enclosing transaction. A later rollback would leave a
  // spurious nudge, but a debounced push against an empty outbox is a clean
  // no-op, so this is safe.
  emitOutboxChange();
}

type ImportChangeOptions = {
  /** Pre-existing row ids that the caller cleared (replace-mode only) — they
   *  get delete tombstones on the wire so the cloud actually drops them. Ids
   *  also present in `data` are coalesced into the upsert instead. */
  deletedIds?: { entries: string[]; prescriptions: string[] };
  /** Every symptom string found on the imported rows. Any not already known
   *  to the profile are added to `profile.symptomOptions` with a generated
   *  color, in the same Dexie write and the same outbox entry as the rest of
   *  the import — so there's exactly one profile push per import. */
  importedSymptoms?: Iterable<string>;
};

export type HealthDataImportData = {
  entries: HealthEntry[];
  prescriptions: Prescription[];
  profile?: ProfileSettings;
};

export type ApplyHealthDataImportInput = {
  mode: 'merge' | 'replace';
  replaceProfile: boolean;
  data: HealthDataImportData;
};

export type ApplyHealthDataImportResult = {
  appliedEntries: HealthEntry[];
  persistedProfile?: ProfileSettings;
  skippedDuplicateEntries: number;
};

function importEntryKey(
  entry: Pick<HealthEntry, 'date' | 'weightLbs' | 'amountMg' | 'medication'>,
): string {
  const weight = entry.weightLbs != null ? Math.round(entry.weightLbs * 10) / 10 : 'none';
  const dose = entry.amountMg != null ? entry.amountMg.toFixed(3) : 'none';
  return `${entry.date}#${weight}#${dose}#${entry.medication ?? ''}`;
}

function deduplicateImportedEntries(
  entries: HealthEntry[],
  existing: Pick<HealthEntry, 'date' | 'weightLbs' | 'amountMg' | 'medication'>[],
): { entries: HealthEntry[]; skippedDuplicateEntries: number } {
  const seen = new Set(existing.map(importEntryKey));
  const unique: HealthEntry[] = [];
  let skippedDuplicateEntries = 0;
  for (const entry of entries) {
    const key = importEntryKey(entry);
    if (seen.has(key)) {
      skippedDuplicateEntries += 1;
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return { entries: unique, skippedDuplicateEntries };
}

export async function applyHealthDataImport(
  input: ApplyHealthDataImportInput,
): Promise<ApplyHealthDataImportResult> {
  let appliedEntries = input.data.entries;
  let skippedDuplicateEntries = 0;
  let persistedProfile: ProfileSettings | undefined;
  let hasOutgoingChanges = false;
  await db.transaction(
    'rw',
    [db.entries, db.prescriptions, db.profile, db.outbox],
    async () => {
      await assertDataEditAllowed('entry');
      if (input.mode === 'merge') {
        const deduplicated = deduplicateImportedEntries(
          input.data.entries,
          await db.entries.toArray(),
        );
        appliedEntries = deduplicated.entries;
        skippedDuplicateEntries = deduplicated.skippedDuplicateEntries;
      }
      const importedSymptoms = new Set(
        appliedEntries.flatMap((entry) => entry.symptoms ?? []),
      );

      let deletedIds: ImportChangeOptions['deletedIds'];
      if (input.mode === 'replace') {
        const [entryIds, prescriptionIds] = await Promise.all([
          db.entries.toCollection().primaryKeys(),
          db.prescriptions.toCollection().primaryKeys(),
        ]);
        deletedIds = {
          entries: entryIds as string[],
          prescriptions: prescriptionIds as string[],
        };
        await Promise.all([
          db.entries.clear(),
          db.prescriptions.clear(),
          input.replaceProfile ? db.profile.clear() : Promise.resolve(),
        ]);
      }

      await Promise.all([
        appliedEntries.length ? db.entries.bulkPut(appliedEntries) : Promise.resolve(),
        input.data.prescriptions.length
          ? db.prescriptions.bulkPut(input.data.prescriptions)
          : Promise.resolve(),
      ]);
      const changes = await enqueueImportChanges(
        { ...input.data, entries: appliedEntries },
        { deletedIds, importedSymptoms },
      );
      persistedProfile = changes.persistedProfile;
      hasOutgoingChanges = changes.hasOutgoingChanges;
    },
  );

  if (hasOutgoingChanges) emitOutboxChange();
  if (input.mode === 'replace') emitHealthChange({ action: 'reset' });
  for (const entry of appliedEntries) emitHealthChange({ action: 'add', entity: entry });

  return {
    appliedEntries,
    persistedProfile,
    skippedDuplicateEntries,
  };
}

/**
 * Apply a bulk import's profile-side work and enqueue every matching outbox
 * row inside the storage-owned transaction:
 *
 *   1. Decides which profile to persist: the imported profile (if any),
 *      otherwise the existing one patched with new symptoms, otherwise a
 *      stub seeded with the new symptoms. If neither an imported profile
 *      nor new symptoms are present, the profile row is left untouched.
 *   2. Writes that profile to `db.profile` (if any).
 *   3. Builds outbox entries: delete tombstones for `deletedIds`, upserts
 *      for every row in `data`, and a single upsert for the merged profile.
 *
 * A single profile write per import keeps push order deterministic and avoids the brief window where
 * the cloud could see a profile that lacks the symptoms its rows reference.
 */
async function enqueueImportChanges(
  data: HealthDataImportData,
  options: ImportChangeOptions = {},
): Promise<{ persistedProfile?: ProfileSettings; hasOutgoingChanges: boolean }> {
  const { deletedIds, importedSymptoms } = options;
  const profileToPersist = await mergeImportedProfile(data.profile, importedSymptoms);
  if (profileToPersist) {
    await db.profile.put(profileToPersist);
  }

  const enqueuedAt = now();
  const entries: OutboxEntry[] = [];
  const importedIds = {
    entry: new Set(data.entries.map((e) => e.id)),
    prescription: new Set(data.prescriptions.map((p) => p.id)),
  };

  function tombstone(aggregate: SyncAggregate, ids: string[] | undefined, kept: Set<string>) {
    for (const id of ids ?? []) {
      if (kept.has(id)) continue;
      entries.push({
        id: `${aggregate}:${id}`,
        aggregate,
        entityId: id,
        op: 'delete',
        updatedAt: enqueuedAt,
        payload: null,
        enqueuedAt,
        rev: nanoid(),
      });
    }
  }

  function upsert(aggregate: SyncAggregate, entityId: string, updatedAt: IsoDateTime, payload: unknown) {
    entries.push({
      id: `${aggregate}:${entityId}`,
      aggregate,
      entityId,
      op: 'upsert',
      updatedAt,
      payload,
      enqueuedAt,
      rev: nanoid(),
    });
  }

  tombstone('entry', deletedIds?.entries, importedIds.entry);
  tombstone('prescription', deletedIds?.prescriptions, importedIds.prescription);

  for (const e of data.entries) upsert('entry', e.id, e.updatedAt, e);
  for (const p of data.prescriptions) upsert('prescription', p.id, p.updatedAt, p);
  if (profileToPersist) {
    upsert('profile', 'profile', profileToPersist.updatedAt, toSyncableProfile(profileToPersist));
  }

  if (entries.length > 0) {
    await db.outbox.bulkPut(entries);
  }

  return {
    persistedProfile: profileToPersist,
    hasOutgoingChanges: entries.length > 0,
  };
}

/**
 * Compute the profile that should be persisted as part of an import.
 *
 * Three cases:
 *   - Import carries a profile + new symptoms: fold the symptoms into the
 *     imported profile (the import wins on every field, including starting
 *     point for the symptom list).
 *   - No imported profile, but new symptoms: patch the existing profile (or
 *     stub one) with `symptomOptions` and `symptomColors`.
 *   - Neither: return undefined — no profile write needed.
 *
 * Whenever the function returns a value, `updatedAt` is bumped so the new
 * version wins LWW against any concurrent edit on another device.
 */
async function mergeImportedProfile(
  importedProfile: ProfileSettings | undefined,
  importedSymptoms: Iterable<string> | undefined,
): Promise<ProfileSettings | undefined> {
  const symptomSet = new Set<string>();
  if (importedSymptoms) {
    for (const raw of importedSymptoms) {
      const trimmed = raw.trim();
      if (trimmed) symptomSet.add(trimmed);
    }
  }

  const existing = await db.profile.get('profile');
  const baseForSymptoms = importedProfile ?? existing;
  const baseOptions = baseForSymptoms?.symptomOptions ?? [...DEFAULT_SYMPTOM_OPTIONS];
  const baseColors = baseForSymptoms?.symptomColors ?? {};

  const known = new Set(baseOptions);
  const additions: string[] = [];
  for (const symptom of symptomSet) {
    if (known.has(symptom)) continue;
    known.add(symptom);
    additions.push(symptom);
  }

  const ts = now();

  if (importedProfile) {
    if (additions.length === 0) return importedProfile;
    const nextColors = { ...baseColors };
    for (const symptom of additions) nextColors[symptom] = generateSymptomColor();
    return {
      ...importedProfile,
      symptomOptions: [...baseOptions, ...additions],
      symptomColors: nextColors,
      updatedAt: ts,
    };
  }

  if (additions.length === 0) return undefined;

  const nextOptions = [...baseOptions, ...additions];
  const nextColors = { ...baseColors };
  for (const symptom of additions) nextColors[symptom] = generateSymptomColor();

  if (existing) {
    return {
      ...existing,
      symptomOptions: nextOptions,
      symptomColors: nextColors,
      updatedAt: ts,
    };
  }

  const seed: ProfileSettings = {
    id: 'profile',
    passphraseEnabled: false,
    syncMode: DEFAULT_SYNC_MODE,
    symptomOptions: nextOptions,
    symptomColors: nextColors,
    createdAt: ts,
    updatedAt: ts,
  };
  return stampAllFields(seed, ts, { reserved: PROFILE_DEVICE_LOCAL });
}

// ── Remote apply ───────────────────────────────────────────────────────────
// The inbound counterpart to the outbox: changes pulled from the cloud are
// applied here, last-writer-wins. These write straight to the entity tables
// and DO NOT enqueue an outbox entry — an applied remote change must never
// bounce back as a new local event. Entry writes still emit a HealthDataChange
// so the (non-liveQuery) health store updates; prescriptions and profile are
// observed via liveQuery / re-read on next load.

function parseTime(value: IsoDateTime): number {
  return new Date(value).getTime();
}

/**
 * Drop a pending outbox entry that a just-applied remote change has
 * superseded. Without this, a stale local edit (e.g. `X@T1`) would still be
 * sitting in the outbox after we pull-and-apply a newer `X@T2`, and the next
 * push would clobber the cloud back to `T1`. The entry is kept only if it is
 * genuinely newer than what we applied.
 */
async function reconcileOutbox(
  aggregate: SyncAggregate,
  entityId: string,
  appliedUpdatedAt: IsoDateTime,
): Promise<void> {
  const outboxId = `${aggregate}:${entityId}`;
  const pending = await db.outbox.get(outboxId);
  if (pending && parseTime(pending.updatedAt) <= parseTime(appliedUpdatedAt)) {
    await db.outbox.delete(outboxId);
  }
}

type ApplyOutcome<T> = {
  result: 'upsert' | 'delete' | null;
  /** The record now in the table (post-merge for mergeable aggregates), or
   * null for deletes / no-ops. Callers emit this so consumers see the same
   * shape that's actually stored, not the raw remote payload. */
  stored: T | null;
};

async function applyEntityChange<T extends Mergeable>(
  table: Table<T, string>,
  aggregate: SyncAggregate,
  entityId: string,
  op: 'upsert' | 'delete',
  record: unknown,
  remoteUpdatedAt: IsoDateTime,
): Promise<ApplyOutcome<T>> {
  const outcome: ApplyOutcome<T> = { result: null, stored: null };
  await db.transaction('rw', table, db.outbox, async () => {
    const local = await table.get(entityId);

    if (op === 'delete') {
      // Delete wins ties: a delete stamped at the same instant as the local
      // edit removes the row; only a strictly newer local edit keeps it.
      if (local && parseTime(remoteUpdatedAt) >= parseTime(local.updatedAt)) {
        await table.delete(entityId);
        outcome.result = 'delete';
        await reconcileOutbox(aggregate, entityId, remoteUpdatedAt);
      }
      return;
    }

    // Brand-new entity: nothing to merge against, just take the remote.
    if (!local) {
      await table.put(record as T);
      outcome.result = 'upsert';
      outcome.stored = record as T;
      await reconcileOutbox(aggregate, entityId, remoteUpdatedAt);
      return;
    }

    if (MERGEABLE_AGGREGATES.has(aggregate)) {
      const remote = record as T;
      const { merged, localHasNews, remoteHasNews } = mergeRecord(local, remote);
      if (remoteHasNews) {
        await table.put(merged);
        outcome.result = 'upsert';
        outcome.stored = merged;
      }
      if (localHasNews) {
        // The snapshot we just pulled is missing fields this device has —
        // re-enqueue the merge result so the cloud (and other devices) catch
        // up on the next push. Without this, a third device pulling the same
        // remote would never see our local-only fields.
        await replaceOutboxWithMerge(aggregate, entityId, merged);
      } else if (outcome.result) {
        // Pure remote-wins merge: drop the now-stale outbox if any.
        await reconcileOutbox(aggregate, entityId, remoteUpdatedAt);
      }
      return;
    }

    // Whole-row LWW for aggregates not yet migrated to per-field merge.
    if (parseTime(remoteUpdatedAt) > parseTime(local.updatedAt)) {
      await table.put(record as T);
      outcome.result = 'upsert';
      outcome.stored = record as T;
      await reconcileOutbox(aggregate, entityId, remoteUpdatedAt);
    }
  });
  return outcome;
}

/**
 * Replace (or create) the outbox entry for an entity whose merge produced
 * fields the cloud's current snapshot lacks. Bumps `rev` so a concurrent push
 * can't silently clear this enqueue mid-flight (matches the `rev` check in
 * `clearPushedOutboxRows`).
 */
async function replaceOutboxWithMerge(
  aggregate: SyncAggregate,
  entityId: string,
  payload: { updatedAt: IsoDateTime },
): Promise<void> {
  await db.outbox.put({
    id: `${aggregate}:${entityId}`,
    aggregate,
    entityId,
    op: 'upsert',
    updatedAt: payload.updatedAt,
    payload,
    enqueuedAt: now(),
    rev: nanoid(),
  });
  emitOutboxChange();
}

async function applyRemoteProfileChange(
  op: 'upsert' | 'delete',
  record: unknown,
  remoteUpdatedAt: IsoDateTime,
): Promise<boolean> {
  // A profile is never deleted — the local row also carries this device's
  // sync state (syncMode, e2eeMigration), so a delete event is ignored.
  if (op === 'delete') return false;

  let applied = false;
  await db.transaction('rw', db.profile, db.outbox, async () => {
    const local = await db.profile.get('profile');
    const remote = (record ?? {}) as Partial<ProfileSettings>;

    // Bootstrap: no local profile yet. Take the remote wholesale and seed the
    // device-local fields to safe defaults. (`passphraseEnabled: false` mirrors
    // what `toSyncableProfile` strips out before pushing, so we never trust a
    // remote-supplied value for it.)
    if (!local) {
      await db.profile.put({
        ...remote,
        id: 'profile',
        createdAt: remote.createdAt ?? now(),
        updatedAt: remote.updatedAt ?? remoteUpdatedAt,
        passphraseEnabled: false,
      });
      await reconcileOutbox('profile', 'profile', remoteUpdatedAt);
      applied = true;
      return;
    }

    // Per-field LWW. Device-local fields are reserved — they stay on `local`
    // unchanged, and `fieldUpdatedAt` never gains entries for them.
    const remoteAsProfile: ProfileSettings = {
      ...remote,
      id: 'profile',
      createdAt: local.createdAt,
      updatedAt: remote.updatedAt ?? remoteUpdatedAt,
      passphraseEnabled: local.passphraseEnabled,
      syncMode: local.syncMode,
      e2eeMigration: local.e2eeMigration,
    };
    const { merged, localHasNews, remoteHasNews } = mergeRecord(local, remoteAsProfile, {
      reserved: PROFILE_DEVICE_LOCAL,
    });
    if (remoteHasNews) {
      await db.profile.put(merged);
      applied = true;
    }
    if (localHasNews) {
      // The cloud doesn't have everything we have — re-enqueue the merged
      // syncable view so the next push backfills it. Use the same
      // `toSyncableProfile` strip the regular `saveProfile` path uses, so the
      // wire payload never carries device-local fields.
      await replaceOutboxWithMerge('profile', 'profile', {
        ...(toSyncableProfile(merged) as object),
        updatedAt: merged.updatedAt,
      });
    } else if (applied) {
      await reconcileOutbox('profile', 'profile', remoteUpdatedAt);
    }
  });
  return applied;
}

export type RemoteChange = {
  aggregate: SyncAggregate;
  entityId: string;
  op: 'upsert' | 'delete';
  /** Full entity record for an upsert; null for a delete tombstone. */
  record: unknown;
  /** The originating device's edit/deletion time — the LWW clock. */
  remoteUpdatedAt: IsoDateTime;
};

/**
 * Apply one change pulled from the cloud, last-writer-wins against the local
 * `updatedAt`. Returns true if the change was applied, false if a newer local
 * edit won or the change was a no-op (e.g. deleting something already gone).
 */
export async function applyRemoteChange(change: RemoteChange): Promise<boolean> {
  const { aggregate, entityId, op, record, remoteUpdatedAt } = change;

  // The wire is untrusted at runtime even though callers are typed. The old
  // fall-through below treated every unknown aggregate as `profile`, so a
  // corrupt encrypted envelope could overwrite settings. A payload id that
  // disagrees with the canonical row id is equally unsafe: Dexie would store
  // it under one id while reconciling the outbox under another. Skip malformed
  // events without poisoning the rest of the pull.
  if (aggregate !== 'entry' && aggregate !== 'prescription' && aggregate !== 'profile') {
    return false;
  }
  if (op !== 'upsert' && op !== 'delete') return false;
  if (aggregate === 'profile' && entityId !== 'profile') return false;

  // A malformed remote upsert whose record is null/undefined. The canonical
  // source is a plaintext row written by an older E2EE *disable* migration,
  // which stored the bare record without the `{aggregate, op, record}`
  // envelope steady-state expects — so `pullPlain` decodes its `record` as
  // null. Applying it would `db.<table>.put(null)`, which throws inside
  // Dexie's key-path extraction (`null['id']` → "null is not an object
  // (evaluating 'e[t]')") and aborts the whole pull / migration. There is
  // nothing to write, so skip it as a no-op and let the cycle continue.
  if (op === 'upsert' && (record === null || record === undefined)) {
    return false;
  }
  if (op === 'upsert') {
    if (typeof record !== 'object' || Array.isArray(record)) return false;
    if ((record as { id?: unknown }).id !== entityId) return false;
  }

  if (aggregate === 'entry') {
    const { result, stored } = await applyEntityChange(
      db.entries,
      'entry',
      entityId,
      op,
      record,
      remoteUpdatedAt,
    );
    if (result === 'upsert' && stored) {
      // Emit the actually-stored row (post-merge), not the raw remote — consumers
      // diverge from Dexie otherwise when a per-field merge has happened.
      emitHealthChange({ action: 'add', entity: stored });
    } else if (result === 'delete') {
      emitHealthChange({ action: 'delete', id: entityId });
    }
    return result !== null;
  }

  if (aggregate === 'prescription') {
    // medicationStore observes db.prescriptions via liveQuery — no event needed.
    const { result } = await applyEntityChange(
      db.prescriptions,
      'prescription',
      entityId,
      op,
      record,
      remoteUpdatedAt,
    );
    return result !== null;
  }

  if (aggregate === 'profile') {
    return applyRemoteProfileChange(op, record, remoteUpdatedAt);
  }

  return false;
}

function hasSortOrder(prescription: Prescription): prescription is Prescription & { sortOrder: number } {
  return typeof prescription.sortOrder === 'number' && Number.isFinite(prescription.sortOrder);
}

export function sortPrescriptionsByDisplayOrder(prescriptions: Prescription[]): Prescription[] {
  const allHaveSortOrder = prescriptions.every(hasSortOrder);

  return [...prescriptions].sort((a, b) => {
    if (allHaveSortOrder && hasSortOrder(a) && hasSortOrder(b)) {
      const order = a.sortOrder - b.sortOrder;
      if (order !== 0) return order;
    }

    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

// ── Health entries (unified weigh-in + dose rows) ───────────────────────────

export async function addEntry(
  input: Omit<HealthEntry, 'id' | 'createdAt' | 'updatedAt' | 'date'> & { date?: IsoDate },
): Promise<HealthEntry> {
  const ts = now();
  // Seed `fieldUpdatedAt` for every persistent field at creation time so future
  // per-field merges have an explicit clock to compare against.
  const item: HealthEntry = stampAllFields(
    {
      id: nanoid(),
      createdAt: ts,
      updatedAt: ts,
      ...input,
      date: input.date ?? localDateKey(),
      symptoms: input.symptoms ?? [],
    },
    ts,
  );
  await db.transaction('rw', db.entries, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('entry');
    await db.entries.put(item);
    await writeOutboxChange('entry', item.id, 'upsert', item.updatedAt, item);
  });
  emitHealthChange({ action: 'add', entity: item });
  return item;
}

export async function updateEntry(
  id: string,
  data: Partial<Omit<HealthEntry, 'id' | 'createdAt'>>,
): Promise<void> {
  const ts = now();
  let patchForEvent: Partial<HealthEntry> | null = null;
  await db.transaction('rw', db.entries, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('entry');
    const before = await db.entries.get(id);
    if (!before) return;
    const merged = applyPatchWithClears(before, data);
    const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
    const updated: HealthEntry = { ...merged, fieldUpdatedAt, updatedAt };
    await db.entries.put(updated);
    await writeOutboxChange('entry', id, 'upsert', updated.updatedAt, updated);
    patchForEvent = { ...data, updatedAt };
  });
  if (patchForEvent) emitHealthChange({ action: 'patch', id, patch: patchForEvent });
}

// Applies the same patch to many entries in one transaction and emits a single
// change event. Callers backfilling a field across the table (e.g. assigning a
// medication to a bulk import) should use this — N sequential updateEntry calls
// trigger N store rebuilds and N full PK/chart recomputes on the main thread.
export async function bulkUpdateEntries(
  ids: string[],
  data: Partial<Omit<HealthEntry, 'id' | 'createdAt'>>,
): Promise<void> {
  if (ids.length === 0) return;
  const ts = now();
  await db.transaction('rw', db.entries, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('entry');
    for (const id of ids) {
      const before = await db.entries.get(id);
      if (!before) continue;
      const merged = applyPatchWithClears(before, data);
      const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
      const updated: HealthEntry = { ...merged, fieldUpdatedAt, updatedAt };
      await db.entries.put(updated);
      await writeOutboxChange('entry', id, 'upsert', updated.updatedAt, updated);
    }
  });
  emitHealthChange({ action: 'bulkPatch', ids, patch: { ...data, updatedAt: ts } });
}

export async function deleteEntry(id: string): Promise<void> {
  const deletedAt = now();
  await db.transaction('rw', db.entries, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('entry');
    const existing = await db.entries.get(id);
    await db.entries.delete(id);
    if (existing) await writeOutboxChange('entry', id, 'delete', deletedAt, null);
  });
  emitHealthChange({ action: 'delete', id });
}

export async function getAllEntries(): Promise<HealthEntry[]> {
  return db.entries.orderBy('date').toArray();
}

export async function hasPlainHealthData(): Promise<boolean> {
  const [entries, vials] = await Promise.all([
    db.entries.count(),
    db.prescriptions.count(),
  ]);
  return entries + vials > 0;
}

// ── Prescriptions ──────────────────────────────────────────────────────────

export async function addPrescription(
  input: Omit<Prescription, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Prescription> {
  const ts = now();
  let item!: Prescription;
  await db.transaction('rw', db.prescriptions, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('prescription');
    const prescriptions = await db.prescriptions.toArray();
    const maxSortOrder = prescriptions
      .map((prescription) => prescription.sortOrder)
      .filter((sortOrder): sortOrder is number => typeof sortOrder === 'number' && Number.isFinite(sortOrder))
      .reduce((max, sortOrder) => Math.max(max, sortOrder), -1);
    const sortOrder = input.sortOrder ?? (maxSortOrder >= 0 ? maxSortOrder + 1 : prescriptions.length);
    item = stampAllFields(
      { id: nanoid(), createdAt: ts, updatedAt: ts, ...input, sortOrder },
      ts,
    );
    await db.prescriptions.put(item);
    await writeOutboxChange('prescription', item.id, 'upsert', item.updatedAt, item);
  });
  return item;
}

export async function updatePrescription(
  id: string,
  data: Partial<Omit<Prescription, 'id' | 'createdAt'>>,
): Promise<void> {
  const ts = now();
  await db.transaction('rw', db.prescriptions, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('prescription');
    const before = await db.prescriptions.get(id);
    if (!before) return;
    const merged = applyPatchWithClears(before, data);
    const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
    const updated: Prescription = { ...merged, fieldUpdatedAt, updatedAt };
    await db.prescriptions.put(updated);
    await writeOutboxChange('prescription', id, 'upsert', updated.updatedAt, updated);
  });
}

// Applies the same patch to many prescriptions in one transaction. Mirrors
// bulkUpdateEntries so import flows can backfill a medication type across
// multiple vial rows atomically. Prescriptions are observed via liveQuery so
// no change event is emitted here.
export async function bulkUpdatePrescriptions(
  ids: string[],
  data: Partial<Omit<Prescription, 'id' | 'createdAt'>>,
): Promise<void> {
  if (ids.length === 0) return;
  const ts = now();
  await db.transaction('rw', db.prescriptions, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('prescription');
    for (const id of ids) {
      const before = await db.prescriptions.get(id);
      if (!before) continue;
      const merged = applyPatchWithClears(before, data);
      const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
      const updated: Prescription = { ...merged, fieldUpdatedAt, updatedAt };
      await db.prescriptions.put(updated);
      await writeOutboxChange('prescription', id, 'upsert', updated.updatedAt, updated);
    }
  });
}

export async function deletePrescription(id: string): Promise<void> {
  const deletedAt = now();
  await db.transaction('rw', db.prescriptions, db.profile, db.outbox, async () => {
    await assertDataEditAllowed('prescription');
    const existing = await db.prescriptions.get(id);
    await db.prescriptions.delete(id);
    if (existing) await writeOutboxChange('prescription', id, 'delete', deletedAt, null);
  });
}

export async function getAllPrescriptions(): Promise<Prescription[]> {
  return sortPrescriptionsByDisplayOrder(await db.prescriptions.toArray());
}

// ── Profile ────────────────────────────────────────────────────────────────

export async function getProfile(): Promise<ProfileSettings | undefined> {
  return db.profile.get('profile');
}

export function observeProfile(
  run: (profile: ProfileSettings | undefined) => void,
  onError: (error: unknown) => void = (error) => {
    console.error('Health Data Storage profile observation failed:', error);
  },
): () => void {
  const subscription = liveQuery(getProfile).subscribe({ next: run, error: onError });
  return () => subscription.unsubscribe();
}

/**
 * Set this device's sync-mode bookkeeping (`syncMode`, `passphraseEnabled`,
 * `e2eeMigration`) without enqueueing an outbox push. These fields are
 * device-local — `toSyncableProfile` strips them on the way out and
 * `applyRemoteProfileChange` strips them on the way in — so pushing the
 * profile from here would be a no-op at best and a wasted round-trip at
 * worst. The orchestrator's server-mode reconciliation calls this to flip a
 * stale local mode to match what the server already knows.
 */
export async function setLocalProfileSyncState(state: {
  syncMode?: SyncMode;
  passphraseEnabled?: boolean;
  e2eeMigration?: ProfileSettings['e2eeMigration'];
}): Promise<void> {
  const ts = now();
  await db.transaction('rw', db.profile, async () => {
    const existing = await db.profile.get('profile');
    if (existing) {
      const updated = { ...existing, ...state, updatedAt: ts };
      await db.profile.put(updated);
      return;
    }
    const seed: ProfileSettings = {
      id: 'profile',
      passphraseEnabled: state.passphraseEnabled ?? false,
      syncMode: state.syncMode ?? DEFAULT_SYNC_MODE,
      e2eeMigration: state.e2eeMigration,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.profile.put(stampAllFields(seed, ts, { reserved: PROFILE_DEVICE_LOCAL }));
  });
}

export async function saveProfile(
  partial: Partial<Omit<ProfileSettings, 'id' | 'createdAt'>>,
): Promise<void> {
  const ts = now();
  await db.transaction('rw', db.profile, db.outbox, async () => {
    const existing = await db.profile.get('profile');
    let saved: ProfileSettings;
    if (existing) {
      const merged = applyPatchWithClears(existing, partial);
      const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(partial), ts, {
        reserved: PROFILE_DEVICE_LOCAL,
      });
      saved = { ...merged, fieldUpdatedAt, updatedAt };
      await db.profile.put(saved);
    } else {
      const seed: ProfileSettings = {
        id: 'profile',
        passphraseEnabled: false,
        syncMode: DEFAULT_SYNC_MODE,
        createdAt: ts,
        updatedAt: ts,
        ...partial,
      };
      saved = stampAllFields(seed, ts, { reserved: PROFILE_DEVICE_LOCAL });
      await db.profile.put(saved);
    }
    await writeOutboxChange('profile', 'profile', 'upsert', saved.updatedAt, toSyncableProfile(saved));
  });
}

// ── Bulk ───────────────────────────────────────────────────────────────────

export async function clearAllData(): Promise<void> {
  // Deliberately bypasses the outbox: this is a local-only reset, not a set of
  // user edits to propagate. Verified erasure and logout coordination remain
  // separate from ordinary Health Data Storage operations.
  await Promise.all([
    db.entries.clear(),
    db.prescriptions.clear(),
    db.profile.clear(),
  ]);
  emitHealthChange({ action: 'reset' });
}

import { nanoid } from 'nanoid';
import type { Table } from 'dexie';
import { db } from '$lib/db/schema';
import type {
  InjectionEntry,
  IsoDate,
  IsoDateTime,
  OutboxEntry,
  Prescription,
  ProfileSettings,
  SyncAggregate,
  SyncMode,
  WeightEntry,
} from '$lib/domain/types';
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

const now = () => new Date().toISOString();
export const DEFAULT_SYNC_MODE: SyncMode = 'plain';

// ── Change events ──────────────────────────────────────────────────────────
// Emitted after each weight/injection mutation so caches can update
// incrementally instead of re-reading the full table from IndexedDB.

export type HealthDataChange =
  | { kind: 'weight'; action: 'add'; entity: WeightEntry }
  | { kind: 'weight'; action: 'patch'; id: string; patch: Partial<WeightEntry> }
  | { kind: 'weight'; action: 'delete'; id: string }
  | { kind: 'weight'; action: 'reset' }
  | { kind: 'injection'; action: 'add'; entity: InjectionEntry }
  | { kind: 'injection'; action: 'patch'; id: string; patch: Partial<InjectionEntry> }
  | { kind: 'injection'; action: 'bulkPatch'; ids: string[]; patch: Partial<InjectionEntry> }
  | { kind: 'injection'; action: 'delete'; id: string }
  | { kind: 'injection'; action: 'reset' };

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
  const { syncMode: _syncMode, e2eeMigration: _e2eeMigration, ...rest } = profile;
  return { ...rest, passphraseEnabled: false };
}

async function enqueueOutbox(
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

/**
 * Enqueue outbox rows for a bulk import. Imports write straight to the entity
 * tables (one `bulkPut` per aggregate) so they bypass the per-row mutate
 * helpers that normally enqueue — without this, imported data lives only on
 * the importing device and is silently invisible to every other one.
 *
 * Must be called inside a transaction that already includes `db.outbox` and
 * the entity tables; the caller does the writes, this just records the
 * matching outbox events. `deletedIds` are tombstoned (used by replace mode
 * to drop rows that existed before the import); rows that appear in both
 * lists are coalesced into a single upsert because outbox keys are
 * `${aggregate}:${entityId}` and the upsert is what the caller actually
 * wants on the remote.
 */
export async function enqueueImportedRows(
  data: {
    weights: WeightEntry[];
    injections: InjectionEntry[];
    prescriptions: Prescription[];
    profile?: ProfileSettings;
  },
  deletedIds?: { weights: string[]; injections: string[]; prescriptions: string[] },
): Promise<void> {
  const enqueuedAt = now();
  const entries: OutboxEntry[] = [];
  const importedIds = {
    weight: new Set(data.weights.map((w) => w.id)),
    injection: new Set(data.injections.map((i) => i.id)),
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

  tombstone('weight', deletedIds?.weights, importedIds.weight);
  tombstone('injection', deletedIds?.injections, importedIds.injection);
  tombstone('prescription', deletedIds?.prescriptions, importedIds.prescription);

  for (const w of data.weights) upsert('weight', w.id, w.updatedAt, w);
  for (const i of data.injections) upsert('injection', i.id, i.updatedAt, i);
  for (const p of data.prescriptions) upsert('prescription', p.id, p.updatedAt, p);
  if (data.profile) {
    upsert('profile', 'profile', data.profile.updatedAt, toSyncableProfile(data.profile));
  }

  if (entries.length === 0) return;
  await db.outbox.bulkPut(entries);
  emitOutboxChange();
}

// ── Remote apply ───────────────────────────────────────────────────────────
// The inbound counterpart to the outbox: changes pulled from the cloud are
// applied here, last-writer-wins. These write straight to the entity tables
// and DO NOT enqueue an outbox entry — an applied remote change must never
// bounce back as a new local event. Weight/injection writes still emit a
// HealthDataChange so the (non-liveQuery) health store updates; prescriptions
// and profile are observed via liveQuery / re-read on next load.

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

  if (aggregate === 'weight') {
    const { result, stored } = await applyEntityChange(
      db.weights,
      'weight',
      entityId,
      op,
      record,
      remoteUpdatedAt,
    );
    if (result === 'upsert' && stored) {
      // Emit the actually-stored row (post-merge), not the raw remote — consumers
      // diverge from Dexie otherwise when a per-field merge has happened.
      emitHealthChange({ kind: 'weight', action: 'add', entity: stored });
    } else if (result === 'delete') {
      emitHealthChange({ kind: 'weight', action: 'delete', id: entityId });
    }
    return result !== null;
  }

  if (aggregate === 'injection') {
    const { result, stored } = await applyEntityChange(
      db.injections,
      'injection',
      entityId,
      op,
      record,
      remoteUpdatedAt,
    );
    if (result === 'upsert' && stored) {
      emitHealthChange({ kind: 'injection', action: 'add', entity: stored });
    } else if (result === 'delete') {
      emitHealthChange({ kind: 'injection', action: 'delete', id: entityId });
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

  return applyRemoteProfileChange(op, record, remoteUpdatedAt);
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

// ── Weights ────────────────────────────────────────────────────────────────

export async function addWeight(data: {
  date?: IsoDate;
  weightLbs?: number;
  wellness?: number;
  systemMg?: number;
  symptoms?: string[];
  notes?: string;
}): Promise<WeightEntry> {
  const ts = now();
  // Seed `fieldUpdatedAt` for every persistent field at creation time so
  // future per-field merges have an explicit clock to compare against
  // (instead of inheriting the row clock, which moves on every edit).
  const item: WeightEntry = stampAllFields(
    {
      id: nanoid(),
      date: data.date ?? localDateKey(),
      weightLbs: data.weightLbs,
      wellness: data.wellness,
      systemMg: data.systemMg,
      symptoms: data.symptoms,
      notes: data.notes,
      createdAt: ts,
      updatedAt: ts,
    },
    ts,
  );
  await db.transaction('rw', db.weights, db.outbox, async () => {
    await db.weights.put(item);
    await enqueueOutbox('weight', item.id, 'upsert', item.updatedAt, item);
  });
  emitHealthChange({ kind: 'weight', action: 'add', entity: item });
  return item;
}

export async function updateWeight(
  id: string,
  data: Partial<Omit<WeightEntry, 'id' | 'createdAt'>>,
): Promise<void> {
  const ts = now();
  await db.transaction('rw', db.weights, db.outbox, async () => {
    const before = await db.weights.get(id);
    if (!before) return;
    const merged = applyPatchWithClears(before, data);
    const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
    const updated: WeightEntry = { ...merged, fieldUpdatedAt, updatedAt };
    await db.weights.put(updated);
    await enqueueOutbox('weight', id, 'upsert', updated.updatedAt, updated);
    emitHealthChange({ kind: 'weight', action: 'patch', id, patch: { ...data, updatedAt } });
  });
}

export async function deleteWeight(id: string): Promise<void> {
  const deletedAt = now();
  await db.transaction('rw', db.weights, db.outbox, async () => {
    const existing = await db.weights.get(id);
    await db.weights.delete(id);
    if (existing) await enqueueOutbox('weight', id, 'delete', deletedAt, null);
  });
  emitHealthChange({ kind: 'weight', action: 'delete', id });
}

export async function getAllWeights(): Promise<WeightEntry[]> {
  return db.weights.orderBy('date').toArray();
}

// ── Injections ─────────────────────────────────────────────────────────────

export async function addInjection(
  input: Omit<InjectionEntry, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<InjectionEntry> {
  const ts = now();
  const item: InjectionEntry = stampAllFields(
    { id: nanoid(), createdAt: ts, updatedAt: ts, ...input },
    ts,
  );
  await db.transaction('rw', db.injections, db.outbox, async () => {
    await db.injections.put(item);
    await enqueueOutbox('injection', item.id, 'upsert', item.updatedAt, item);
  });
  emitHealthChange({ kind: 'injection', action: 'add', entity: item });
  return item;
}

export async function updateInjection(
  id: string,
  data: Partial<Omit<InjectionEntry, 'id' | 'createdAt'>>,
): Promise<void> {
  const ts = now();
  let patchForEvent: Partial<InjectionEntry> | null = null;
  await db.transaction('rw', db.injections, db.outbox, async () => {
    const before = await db.injections.get(id);
    if (!before) return;
    const merged = applyPatchWithClears(before, data);
    const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
    const updated: InjectionEntry = { ...merged, fieldUpdatedAt, updatedAt };
    await db.injections.put(updated);
    await enqueueOutbox('injection', id, 'upsert', updated.updatedAt, updated);
    patchForEvent = { ...data, updatedAt };
  });
  if (patchForEvent) emitHealthChange({ kind: 'injection', action: 'patch', id, patch: patchForEvent });
}

// Applies the same patch to many injections in one transaction and emits a
// single change event. Callers that need to backfill a field across the whole
// table (e.g. assigning a medication to a bulk import) should use this — doing
// it as N sequential updateInjection calls triggers N store rebuilds, which
// chains into N full PK/chart recomputes on the main thread.
export async function bulkUpdateInjections(
  ids: string[],
  data: Partial<Omit<InjectionEntry, 'id' | 'createdAt'>>,
): Promise<void> {
  if (ids.length === 0) return;
  const ts = now();
  // Note: each row gets its own `updatedAt` derived from its own pre-edit row
  // clock via `bumpFieldStamps`. The emitted bulkPatch carries the bulk `ts`
  // as a representative timestamp — listeners use it for "newer than ours?"
  // cache decisions, not as a per-row truth.
  await db.transaction('rw', db.injections, db.outbox, async () => {
    for (const id of ids) {
      const before = await db.injections.get(id);
      if (!before) continue;
      const merged = applyPatchWithClears(before, data);
      const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
      const updated: InjectionEntry = { ...merged, fieldUpdatedAt, updatedAt };
      await db.injections.put(updated);
      await enqueueOutbox('injection', id, 'upsert', updated.updatedAt, updated);
    }
  });
  emitHealthChange({
    kind: 'injection',
    action: 'bulkPatch',
    ids,
    patch: { ...data, updatedAt: ts },
  });
}

export async function deleteInjection(id: string): Promise<void> {
  const deletedAt = now();
  await db.transaction('rw', db.injections, db.outbox, async () => {
    const existing = await db.injections.get(id);
    await db.injections.delete(id);
    if (existing) await enqueueOutbox('injection', id, 'delete', deletedAt, null);
  });
  emitHealthChange({ kind: 'injection', action: 'delete', id });
}

export async function getAllInjections(): Promise<InjectionEntry[]> {
  return db.injections.orderBy('date').toArray();
}

// ── Prescriptions ──────────────────────────────────────────────────────────

export async function addPrescription(
  input: Omit<Prescription, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Prescription> {
  const ts = now();
  let item!: Prescription;
  await db.transaction('rw', db.prescriptions, db.outbox, async () => {
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
    await enqueueOutbox('prescription', item.id, 'upsert', item.updatedAt, item);
  });
  return item;
}

export async function updatePrescription(
  id: string,
  data: Partial<Omit<Prescription, 'id' | 'createdAt'>>,
): Promise<void> {
  const ts = now();
  await db.transaction('rw', db.prescriptions, db.outbox, async () => {
    const before = await db.prescriptions.get(id);
    if (!before) return;
    const merged = applyPatchWithClears(before, data);
    const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
    const updated: Prescription = { ...merged, fieldUpdatedAt, updatedAt };
    await db.prescriptions.put(updated);
    await enqueueOutbox('prescription', id, 'upsert', updated.updatedAt, updated);
  });
}

// Applies the same patch to many prescriptions in one transaction. Mirrors
// bulkUpdateInjections so import flows can backfill a medication type across
// multiple vial rows atomically. Prescriptions are observed via liveQuery so
// no change event is emitted here.
export async function bulkUpdatePrescriptions(
  ids: string[],
  data: Partial<Omit<Prescription, 'id' | 'createdAt'>>,
): Promise<void> {
  if (ids.length === 0) return;
  const ts = now();
  await db.transaction('rw', db.prescriptions, db.outbox, async () => {
    for (const id of ids) {
      const before = await db.prescriptions.get(id);
      if (!before) continue;
      const merged = applyPatchWithClears(before, data);
      const { fieldUpdatedAt, updatedAt } = bumpFieldStamps(merged, Object.keys(data), ts);
      const updated: Prescription = { ...merged, fieldUpdatedAt, updatedAt };
      await db.prescriptions.put(updated);
      await enqueueOutbox('prescription', id, 'upsert', updated.updatedAt, updated);
    }
  });
}

export async function deletePrescription(id: string): Promise<void> {
  const deletedAt = now();
  await db.transaction('rw', db.prescriptions, db.outbox, async () => {
    const existing = await db.prescriptions.get(id);
    await db.prescriptions.delete(id);
    if (existing) await enqueueOutbox('prescription', id, 'delete', deletedAt, null);
  });
}

export async function getAllPrescriptions(): Promise<Prescription[]> {
  return sortPrescriptionsByDisplayOrder(await db.prescriptions.toArray());
}

// ── Profile ────────────────────────────────────────────────────────────────

export async function getProfile(): Promise<ProfileSettings | undefined> {
  return db.profile.get('profile');
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
      await db.profile.put({ ...existing, ...state, updatedAt: ts });
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
    await enqueueOutbox('profile', 'profile', 'upsert', saved.updatedAt, toSyncableProfile(saved));
  });
}

// ── Bulk ───────────────────────────────────────────────────────────────────

export async function clearAllData(): Promise<void> {
  // Deliberately bypasses the outbox: this is a local reset, not a set of
  // user edits to propagate. Bulk import (applyParsedImport) likewise writes
  // straight to the tables. Reconciling these with sync is a later concern.
  await Promise.all([
    db.weights.clear(),
    db.injections.clear(),
    db.prescriptions.clear(),
    db.profile.clear(),
  ]);
  emitHealthChange({ kind: 'weight', action: 'reset' });
  emitHealthChange({ kind: 'injection', action: 'reset' });
}

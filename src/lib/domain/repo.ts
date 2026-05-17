import { nanoid } from 'nanoid';
import type { Table } from 'dexie';
import { db } from '$lib/db/schema';
import type {
  InjectionEntry,
  IsoDate,
  IsoDateTime,
  Prescription,
  ProfileSettings,
  SyncAggregate,
  SyncMode,
  WeightEntry,
} from '$lib/domain/types';
import { localDateKey } from '$lib/utils/dateKeys';

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

async function applyEntityChange<T extends { id: string; updatedAt: IsoDateTime }>(
  table: Table<T, string>,
  aggregate: SyncAggregate,
  entityId: string,
  op: 'upsert' | 'delete',
  record: unknown,
  remoteUpdatedAt: IsoDateTime,
): Promise<'upsert' | 'delete' | null> {
  let result: 'upsert' | 'delete' | null = null;
  await db.transaction('rw', table, db.outbox, async () => {
    const local = await table.get(entityId);
    if (op === 'delete') {
      // Delete wins ties: a delete stamped at the same instant as the local
      // edit removes the row; only a strictly newer local edit keeps it.
      if (local && parseTime(remoteUpdatedAt) >= parseTime(local.updatedAt)) {
        await table.delete(entityId);
        result = 'delete';
      }
    } else if (!local || parseTime(remoteUpdatedAt) > parseTime(local.updatedAt)) {
      await table.put(record as T);
      result = 'upsert';
    }
    if (result) await reconcileOutbox(aggregate, entityId, remoteUpdatedAt);
  });
  return result;
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
    if (local && parseTime(remoteUpdatedAt) <= parseTime(local.updatedAt)) return;

    const remote = (record ?? {}) as Partial<ProfileSettings>;
    await db.profile.put({
      ...remote,
      id: 'profile',
      createdAt: local?.createdAt ?? remote.createdAt ?? now(),
      updatedAt: remote.updatedAt ?? remoteUpdatedAt,
      // Device-local sync state is never overwritten by a synced profile.
      passphraseEnabled: local?.passphraseEnabled ?? false,
      syncMode: local?.syncMode,
      e2eeMigration: local?.e2eeMigration,
    });
    await reconcileOutbox('profile', 'profile', remoteUpdatedAt);
    applied = true;
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
    const result = await applyEntityChange(db.weights, 'weight', entityId, op, record, remoteUpdatedAt);
    if (result === 'upsert') {
      emitHealthChange({ kind: 'weight', action: 'add', entity: record as WeightEntry });
    } else if (result === 'delete') {
      emitHealthChange({ kind: 'weight', action: 'delete', id: entityId });
    }
    return result !== null;
  }

  if (aggregate === 'injection') {
    const result = await applyEntityChange(db.injections, 'injection', entityId, op, record, remoteUpdatedAt);
    if (result === 'upsert') {
      emitHealthChange({ kind: 'injection', action: 'add', entity: record as InjectionEntry });
    } else if (result === 'delete') {
      emitHealthChange({ kind: 'injection', action: 'delete', id: entityId });
    }
    return result !== null;
  }

  if (aggregate === 'prescription') {
    // medicationStore observes db.prescriptions via liveQuery — no event needed.
    const result = await applyEntityChange(
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
  const item: WeightEntry = {
    id: nanoid(),
    date: data.date ?? localDateKey(),
    weightLbs: data.weightLbs,
    wellness: data.wellness,
    systemMg: data.systemMg,
    symptoms: data.symptoms,
    notes: data.notes,
    createdAt: now(),
    updatedAt: now(),
  };
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
  const patch = { ...data, updatedAt: now() };
  await db.transaction('rw', db.weights, db.outbox, async () => {
    await db.weights.update(id, patch);
    const updated = await db.weights.get(id);
    if (updated) await enqueueOutbox('weight', id, 'upsert', updated.updatedAt, updated);
  });
  emitHealthChange({ kind: 'weight', action: 'patch', id, patch });
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
  const item: InjectionEntry = { id: nanoid(), createdAt: now(), updatedAt: now(), ...input };
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
  const patch = { ...data, updatedAt: now() };
  await db.transaction('rw', db.injections, db.outbox, async () => {
    await db.injections.update(id, patch);
    const updated = await db.injections.get(id);
    if (updated) await enqueueOutbox('injection', id, 'upsert', updated.updatedAt, updated);
  });
  emitHealthChange({ kind: 'injection', action: 'patch', id, patch });
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
  const patch = { ...data, updatedAt: now() };
  await db.transaction('rw', db.injections, db.outbox, async () => {
    for (const id of ids) {
      await db.injections.update(id, patch);
      const updated = await db.injections.get(id);
      if (updated) await enqueueOutbox('injection', id, 'upsert', updated.updatedAt, updated);
    }
  });
  emitHealthChange({ kind: 'injection', action: 'bulkPatch', ids, patch });
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
  const createdAt = now();
  let item!: Prescription;
  await db.transaction('rw', db.prescriptions, db.outbox, async () => {
    const prescriptions = await db.prescriptions.toArray();
    const maxSortOrder = prescriptions
      .map((prescription) => prescription.sortOrder)
      .filter((sortOrder): sortOrder is number => typeof sortOrder === 'number' && Number.isFinite(sortOrder))
      .reduce((max, sortOrder) => Math.max(max, sortOrder), -1);
    const sortOrder = input.sortOrder ?? (maxSortOrder >= 0 ? maxSortOrder + 1 : prescriptions.length);
    item = { id: nanoid(), createdAt, updatedAt: createdAt, ...input, sortOrder };
    await db.prescriptions.put(item);
    await enqueueOutbox('prescription', item.id, 'upsert', item.updatedAt, item);
  });
  return item;
}

export async function updatePrescription(
  id: string,
  data: Partial<Omit<Prescription, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.transaction('rw', db.prescriptions, db.outbox, async () => {
    await db.prescriptions.update(id, { ...data, updatedAt: now() });
    const updated = await db.prescriptions.get(id);
    if (updated) await enqueueOutbox('prescription', id, 'upsert', updated.updatedAt, updated);
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

export async function saveProfile(
  partial: Partial<Omit<ProfileSettings, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.transaction('rw', db.profile, db.outbox, async () => {
    const existing = await db.profile.get('profile');
    let saved: ProfileSettings;
    if (existing) {
      const patch = { ...partial, updatedAt: now() };
      await db.profile.update('profile', patch);
      saved = { ...existing, ...patch };
    } else {
      saved = {
        id: 'profile',
        passphraseEnabled: false,
        syncMode: DEFAULT_SYNC_MODE,
        createdAt: now(),
        updatedAt: now(),
        ...partial,
      };
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

import type Dexie from 'dexie';

type StoreSchema = Record<string, string | null>;

// `DB_SCHEMA_VERSION` tracks the *sync protocol* — what we push and pull —
// and is stamped onto every outgoing change row. The local Dexie version
// chain below can advance independently when we add purely local tables
// (e.g. `wrappedKeys`), without bumping the protocol.
//
// v2: synced records gained the optional `fieldUpdatedAt` per-field LWW clock
// (see `$lib/domain/merge`). Older clients pulling v2 payloads ignore the
// extra key and fall back to row-clock LWW, so the bump is observability
// only — no migration required in either direction.
//
// v3: weights + injections are unified into one `entries` store — one record
// per row, each with its own id. The protocol bump means clients speak the
// `entry` aggregate; there is no backward-compat with the old split (pre-launch
// coordinated ship).
export const DB_SCHEMA_VERSION = 3;

export const schemaV1: StoreSchema = {
  weights: 'id,date,updatedAt',
  injections: 'id,date,updatedAt',
  prescriptions: 'id,createdAt,updatedAt',
  profile: 'id,updatedAt',
  encrypted: 'id,entity,keyVersion,updatedAt',
  // Pending local changes awaiting push. One row per entity; `id` is
  // `${aggregate}:${entityId}` so repeated edits coalesce.
  outbox: 'id,aggregate,updatedAt',
  // One-shot ciphertext buffer for the E2EE enable/disable migrations.
  migrationBackfill: 'id,aggregate,createdAt',
};

// Dexie v2 adds the `wrappedKeys` mirror so offline same-device recovery
// can unwrap the DEK without a server round-trip. Existing tables unchanged.
export const schemaV2: StoreSchema = {
  ...schemaV1,
  wrappedKeys: 'id,dekVersion,updatedAt',
};

// Dexie v3 unifies weights + injections into a single `entries` store.
export const schemaV3: StoreSchema = {
  ...schemaV2,
  entries: 'id,date,updatedAt',
  weights: null,
  injections: null,
};

// One-time conversion of the old split tables into unified entries. Same-date
// weight+injection pairs are zipped into one entry (preserving how the table
// looked); extras on a date become their own entries.
async function migrateToUnifiedEntries(tx: {
  table: (name: string) => {
    toArray: () => Promise<Record<string, unknown>[]>;
    bulkAdd: (rows: Record<string, unknown>[]) => Promise<unknown>;
  };
}) {
  const [weights, injections] = await Promise.all([
    tx.table('weights').toArray(),
    tx.table('injections').toArray(),
  ]);

  const byDate = new Map<string, { weights: Record<string, unknown>[]; injections: Record<string, unknown>[] }>();
  const bucket = (date: string) => {
    let b = byDate.get(date);
    if (!b) { b = { weights: [], injections: [] }; byDate.set(date, b); }
    return b;
  };
  for (const w of weights) bucket(String(w.date)).weights.push(w);
  for (const i of injections) bucket(String(i.date)).injections.push(i);

  const maxIso = (a?: unknown, b?: unknown): string =>
    (String(a ?? '') > String(b ?? '') ? String(a ?? '') : String(b ?? '')) || new Date().toISOString();

  const entries: Record<string, unknown>[] = [];
  for (const [date, { weights: ws, injections: is }] of byDate) {
    const rowCount = Math.max(ws.length, is.length, 0);
    for (let i = 0; i < rowCount; i++) {
      const w = ws[i];
      const inj = is[i];
      if (!w && !inj) continue;
      entries.push({
        id: (inj?.id ?? w?.id) as string,
        date,
        weightLbs: w?.weightLbs,
        wellness: w?.wellness,
        symptoms: (w?.symptoms ?? inj?.symptoms ?? []) as string[],
        notes: inj?.notes ?? w?.notes,
        amountMg: inj?.amountMg,
        medication: inj?.medication,
        site: inj?.site,
        prescriptionId: inj?.prescriptionId,
        planned: inj?.planned,
        confirmedAt: inj?.confirmedAt,
        skipped: inj?.skipped,
        createdAt: (inj?.createdAt ?? w?.createdAt) as string,
        updatedAt: maxIso(inj?.updatedAt, w?.updatedAt),
      });
    }
  }

  if (entries.length) await tx.table('entries').bulkAdd(entries);
}

export function defineDatabaseVersions(db: Dexie) {
  db.version(1).stores(schemaV1);
  db.version(2).stores(schemaV2);
  db.version(3).stores(schemaV3).upgrade(migrateToUnifiedEntries as never);
}

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
export const DB_SCHEMA_VERSION = 2;

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

export function defineDatabaseVersions(db: Dexie) {
  db.version(1).stores(schemaV1);
  db.version(2).stores(schemaV2);
}

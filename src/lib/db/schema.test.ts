import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { DB_SCHEMA_VERSION, EvolvTrackDB, db } from '$lib/db/schema';

/**
 * `src/lib/db/schema.ts` is almost entirely type/class declarations and a
 * singleton instance — the runtime behavior worth asserting is:
 *
 *  - The singleton `db` is a `Dexie` instance bound to the right name.
 *  - The expected tables (weights, injections, prescriptions, profile,
 *    encrypted, migrationBackfill, outbox) are addressable.
 *  - `DB_SCHEMA_VERSION` is re-exported from `migrations.ts`.
 *
 * Type definitions (`EncryptedRecord`, table generics) aren't testable at
 * runtime; they're enforced by `svelte-check` / `tsc`.
 */
describe('schema.ts singleton', () => {
  it('exports a Dexie instance named "evolvtrack"', () => {
    expect(db).toBeInstanceOf(EvolvTrackDB);
    expect(db.name).toBe('evolvtrack');
  });

  it('exposes all seven expected tables', async () => {
    // Force open so dexie.tables is populated.
    if (!db.isOpen()) await db.open();
    const tableNames = db.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual([
      'encrypted',
      'injections',
      'migrationBackfill',
      'outbox',
      'prescriptions',
      'profile',
      'weights',
    ]);
  });

  it('makes each table addressable by name on the class instance', () => {
    expect(db.weights).toBeDefined();
    expect(db.injections).toBeDefined();
    expect(db.prescriptions).toBeDefined();
    expect(db.profile).toBeDefined();
    expect(db.encrypted).toBeDefined();
    expect(db.migrationBackfill).toBeDefined();
    expect(db.outbox).toBeDefined();

    // Table accessors should be the same identity across reads.
    expect(db.weights).toBe(db.weights);
  });

  it('re-exports DB_SCHEMA_VERSION from migrations.ts', () => {
    expect(DB_SCHEMA_VERSION).toBe(2);
  });
});

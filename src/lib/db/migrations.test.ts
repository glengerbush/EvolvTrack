import { describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, defineDatabaseVersions, schemaV1, schemaV2, schemaV3 } from '$lib/db/migrations';

describe('DB_SCHEMA_VERSION', () => {
  it('is exported as a positive integer', () => {
    expect(Number.isInteger(DB_SCHEMA_VERSION)).toBe(true);
    expect(DB_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('is currently version 3 (bump this assertion when migrations are added)', () => {
    expect(DB_SCHEMA_VERSION).toBe(3);
  });
});

describe('schemaV1', () => {
  it('declares every table the app expects to read/write', () => {
    expect(Object.keys(schemaV1).sort()).toEqual([
      'encrypted',
      'injections',
      'migrationBackfill',
      'outbox',
      'prescriptions',
      'profile',
      'weights',
    ]);
  });

  it('uses `id` as the primary key for every table', () => {
    for (const [tableName, indices] of Object.entries(schemaV1)) {
      expect(indices, `${tableName} index string`).toBeTruthy();
      const tokens = (indices as string).split(',').map((t) => t.trim());
      expect(tokens[0], `${tableName} primary key`).toBe('id');
    }
  });

  it('indexes date and updatedAt on weights and injections (for chart range + sync queries)', () => {
    expect(schemaV1.weights).toContain('date');
    expect(schemaV1.weights).toContain('updatedAt');
    expect(schemaV1.injections).toContain('date');
    expect(schemaV1.injections).toContain('updatedAt');
  });

  it('indexes entity and keyVersion on encrypted (for re-encrypt sweeps)', () => {
    expect(schemaV1.encrypted).toContain('entity');
    expect(schemaV1.encrypted).toContain('keyVersion');
  });

  it('keys outbox by id and indexes aggregate + updatedAt (for push queries)', () => {
    expect(schemaV1.outbox).toBeTruthy();
    const tokens = (schemaV1.outbox as string).split(',').map((t) => t.trim());
    expect(tokens[0]).toBe('id');
    expect(schemaV1.outbox).toContain('aggregate');
    expect(schemaV1.outbox).toContain('updatedAt');
  });

  it('keys migrationBackfill by id and indexes aggregate + createdAt', () => {
    expect(schemaV1.migrationBackfill).toBeTruthy();
    const tokens = (schemaV1.migrationBackfill as string).split(',').map((t) => t.trim());
    expect(tokens[0]).toBe('id');
    expect(schemaV1.migrationBackfill).toContain('aggregate');
    expect(schemaV1.migrationBackfill).toContain('createdAt');
  });
});

describe('schemaV2', () => {
  it('adds the wrappedKeys mirror table and keeps schemaV1 tables intact', () => {
    expect(Object.keys(schemaV2).sort()).toEqual([
      'encrypted',
      'injections',
      'migrationBackfill',
      'outbox',
      'prescriptions',
      'profile',
      'weights',
      'wrappedKeys',
    ]);
    // Same primary key + index conventions as the rest.
    expect(schemaV2.wrappedKeys).toBeTruthy();
    const tokens = (schemaV2.wrappedKeys as string).split(',').map((t) => t.trim());
    expect(tokens[0]).toBe('id');
    expect(schemaV2.wrappedKeys).toContain('dekVersion');
    expect(schemaV2.wrappedKeys).toContain('updatedAt');
  });

  it('does not alter any schemaV1 store definitions (additive only)', () => {
    for (const [name, def] of Object.entries(schemaV1)) {
      expect(schemaV2[name], `schemaV2.${name} preserved`).toBe(def);
    }
  });
});

describe('schemaV3', () => {
  it('unifies weights+injections into an entries store and drops the old tables', () => {
    expect(schemaV3.entries).toBeTruthy();
    expect(schemaV3.weights).toBeNull();
    expect(schemaV3.injections).toBeNull();
    const tokens = (schemaV3.entries as string).split(',').map((t) => t.trim());
    expect(tokens[0]).toBe('id');
    expect(schemaV3.entries).toContain('date');
    expect(schemaV3.entries).toContain('updatedAt');
  });
});

describe('defineDatabaseVersions', () => {
  it('registers schemaV1, schemaV2, and schemaV3 against a Dexie instance', () => {
    const dexie = new Dexie('migrations-test-define');
    const versionSpy = vi.spyOn(dexie, 'version');

    defineDatabaseVersions(dexie);

    expect(versionSpy).toHaveBeenCalledWith(1);
    expect(versionSpy).toHaveBeenCalledWith(2);
    expect(versionSpy).toHaveBeenCalledWith(3);
    dexie.close();
  });

  it('makes the registered tables addressable on the Dexie instance after open', async () => {
    // Use a unique DB name so the in-memory fake-indexeddb doesn't collide
    // with the global `db` from src/lib/db/schema.ts.
    const dexie = new Dexie('migrations-test-open');
    defineDatabaseVersions(dexie);
    await dexie.open();

    const tableNames = dexie.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual([
      'encrypted',
      'entries',
      'migrationBackfill',
      'outbox',
      'prescriptions',
      'profile',
      'wrappedKeys',
    ]);

    dexie.close();
  });

  it('migrates old weights + injections into unified entries, merging same-date pairs', async () => {
    // Seed a v2 database with the old split tables, then open at v3 and assert
    // the upgrade collapses them into entries (same-date weight+dose = one row).
    const name = 'migrations-test-upgrade';
    const v2 = new Dexie(name);
    v2.version(1).stores(schemaV1);
    v2.version(2).stores(schemaV2);
    await v2.open();
    await v2.table('weights').bulkPut([
      { id: 'w1', date: '2026-06-01', weightLbs: 180, symptoms: [], createdAt: 't', updatedAt: 't' },
      { id: 'w2', date: '2026-06-02', weightLbs: 179, symptoms: [], createdAt: 't', updatedAt: 't' },
    ]);
    await v2.table('injections').bulkPut([
      { id: 'i1', date: '2026-06-01', amountMg: 2.5, medication: 'Semaglutide (Ozempic / Wegovy)', symptoms: [], createdAt: 't', updatedAt: 't' },
    ]);
    v2.close();

    const v3 = new Dexie(name);
    defineDatabaseVersions(v3);
    await v3.open();
    const entries = await v3.table('entries').toArray();
    // 06-01 weight + dose merge into one entry; 06-02 weight stays its own.
    expect(entries).toHaveLength(2);
    const june1 = entries.find((e) => e.date === '2026-06-01');
    expect(june1?.weightLbs).toBe(180);
    expect(june1?.amountMg).toBe(2.5);
    const june2 = entries.find((e) => e.date === '2026-06-02');
    expect(june2?.weightLbs).toBe(179);
    expect(june2?.amountMg).toBeUndefined();
    v3.close();
  });
});

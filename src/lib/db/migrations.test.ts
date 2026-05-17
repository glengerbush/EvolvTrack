import { describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, defineDatabaseVersions, schemaV1 } from '$lib/db/migrations';

describe('DB_SCHEMA_VERSION', () => {
  it('is exported as a positive integer', () => {
    expect(Number.isInteger(DB_SCHEMA_VERSION)).toBe(true);
    expect(DB_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('is currently version 1 (bump this assertion when migrations are added)', () => {
    expect(DB_SCHEMA_VERSION).toBe(1);
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

describe('defineDatabaseVersions', () => {
  it('registers schemaV1 against a Dexie instance', () => {
    const dexie = new Dexie('migrations-test-define');
    const versionSpy = vi.spyOn(dexie, 'version');

    defineDatabaseVersions(dexie);

    expect(versionSpy).toHaveBeenCalledWith(1);
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
      'injections',
      'migrationBackfill',
      'outbox',
      'prescriptions',
      'profile',
      'weights',
    ]);

    dexie.close();
  });
});

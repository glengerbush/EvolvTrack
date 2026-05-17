import Dexie, { type Table } from 'dexie';
import type { InjectionEntry, MigrationBackfillEntry, OutboxEntry, Prescription, ProfileSettings, WeightEntry } from '$lib/domain/types';
import { defineDatabaseVersions } from '$lib/db/migrations';

export { DB_SCHEMA_VERSION } from '$lib/db/migrations';

export interface EncryptedRecord {
  id: string;
  entity: string;
  ciphertext: string;
  iv: string;
  keyVersion: number;
  updatedAt: string;
}

export class EvolvTrackDB extends Dexie {
  weights!: Table<WeightEntry, string>;
  injections!: Table<InjectionEntry, string>;
  prescriptions!: Table<Prescription, string>;
  profile!: Table<ProfileSettings, string>;
  encrypted!: Table<EncryptedRecord, string>;
  migrationBackfill!: Table<MigrationBackfillEntry, string>;
  outbox!: Table<OutboxEntry, string>;

  constructor() {
    super('evolvtrack');
    defineDatabaseVersions(this);
  }
}

export const db = new EvolvTrackDB();

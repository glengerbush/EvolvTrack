import Dexie, { type Table } from 'dexie';
import type {
  HealthEntry,
  MigrationBackfillEntry,
  OutboxEntry,
  Prescription,
  ProfileSettings,
  WrappedKeyBundle,
} from '$lib/domain/types';
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
  entries!: Table<HealthEntry, string>;
  prescriptions!: Table<Prescription, string>;
  profile!: Table<ProfileSettings, string>;
  encrypted!: Table<EncryptedRecord, string>;
  migrationBackfill!: Table<MigrationBackfillEntry, string>;
  outbox!: Table<OutboxEntry, string>;
  wrappedKeys!: Table<WrappedKeyBundle, 'self'>;

  constructor() {
    super('evolvtrack');
    defineDatabaseVersions(this);
  }
}

export const db = new EvolvTrackDB();

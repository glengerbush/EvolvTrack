import Dexie, { type Table } from 'dexie';
import type {
  HealthEntry,
  MigrationBackfillEntry,
  OutboxEntry,
  Prescription,
  ProfileSettings,
  SyncAggregate,
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

/** Durable deletion clock; survives outbox acknowledgments and app restarts. */
export interface DeletionRecord {
  id: string;
  aggregate: SyncAggregate;
  entityId: string;
  updatedAt: string;
}

export class EvolvTrackDB extends Dexie {
  entries!: Table<HealthEntry, string>;
  prescriptions!: Table<Prescription, string>;
  profile!: Table<ProfileSettings, string>;
  encrypted!: Table<EncryptedRecord, string>;
  migrationBackfill!: Table<MigrationBackfillEntry, string>;
  outbox!: Table<OutboxEntry, string>;
  deletions!: Table<DeletionRecord, string>;
  wrappedKeys!: Table<WrappedKeyBundle, 'self'>;

  constructor() {
    super('evolvtrack');
    defineDatabaseVersions(this);
  }
}

export const db = new EvolvTrackDB();

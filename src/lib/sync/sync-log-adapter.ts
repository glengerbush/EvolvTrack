import type { SyncAggregate } from '$lib/domain/types';
import type { SyncOperation } from '$lib/sync/protocol';

export type PlainSyncLogRow = {
  id: string;
  aggregate: SyncAggregate;
  op: SyncOperation;
  payload: unknown;
  protocolVersion: number;
  schemaVersion: number;
  createdAt: string;
  insertedAt: string;
};

export type EncryptedSyncLogRow = {
  id: string;
  ciphertext: string;
  iv: string;
  protocolVersion: number;
  encryptionVersion: number;
  dekVersion: number;
  schemaVersion: number;
  createdAt: string;
  insertedAt: string;
};

export type SyncLogReadOptions = { after?: string | null; dekVersion?: number };
export type SyncLogRevision = { id: string; createdAt: string; insertedAt: string };

/** Owned remote seam. Adapters hide authentication and transport shapes. */
export type SyncLogAdapter = {
  readPlain(options?: SyncLogReadOptions): Promise<PlainSyncLogRow[]>;
  readEncrypted(options?: SyncLogReadOptions): Promise<EncryptedSyncLogRow[]>;
  writePlain(rows: PlainSyncLogRow[]): Promise<void>;
  writeEncrypted(rows: EncryptedSyncLogRow[]): Promise<void>;
  deletePlain(ids?: string[]): Promise<number>;
  deleteEncrypted(ids?: string[]): Promise<number>;
  deleteObservedPlain(rows: SyncLogRevision[]): Promise<number>;
  deleteObservedEncrypted(rows: SyncLogRevision[]): Promise<number>;
  isWriteModeRejection(error: unknown): boolean;
  watch(onChange: () => void, onAuthChange: (signedIn: boolean) => void): () => void;
};

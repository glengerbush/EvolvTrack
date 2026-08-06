import type { SyncAggregate } from '$lib/domain/types';

export const SYNC_PROTOCOL_VERSION = 1;
export type SyncOperation = 'upsert' | 'delete';

export interface EncryptedEnvelope {
  id: string;
  aggregate: SyncAggregate;
  op: SyncOperation;
  ciphertext: string;
  iv: string;
  protocolVersion: number;
  encryptionVersion: number;
  schemaVersion: number;
  createdAt: string;
}

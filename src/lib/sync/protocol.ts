import type { SyncAggregate } from '$lib/domain/types';

export const SYNC_PROTOCOL_VERSION = 1;

export interface EncryptedEnvelope {
  id: string;
  aggregate: SyncAggregate;
  op: 'upsert' | 'delete';
  ciphertext: string;
  iv: string;
  protocolVersion: number;
  encryptionVersion: number;
  schemaVersion: number;
  createdAt: string;
}

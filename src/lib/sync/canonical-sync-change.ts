import type { SyncAggregate } from '$lib/domain/types';
import { DB_SCHEMA_VERSION } from '$lib/db/schema';
import { ENCRYPTION_FORMAT_VERSION } from '$lib/crypto/e2ee';
import { SYNC_PROTOCOL_VERSION, type SyncOperation } from '$lib/sync/protocol';

export type PlainSyncChange = {
  id: string;
  aggregate: SyncAggregate;
  op: SyncOperation;
  payload: unknown;
  protocolVersion: number;
  schemaVersion: number;
  createdAt: string;
};

export type SyncEnvelope = {
  aggregate: SyncAggregate;
  op: SyncOperation;
  record: unknown;
};

export type DecodedSyncChange = SyncEnvelope & { entityId: string };
export type SyncChangeRejection =
  | 'aggregate'
  | 'operation'
  | 'entity-identity'
  | 'payload'
  | 'protocol-version'
  | 'schema-version'
  | 'encryption-version';
export type SyncChangeDecodeResult =
  | { accepted: true; change: DecodedSyncChange }
  | { accepted: false; reason: SyncChangeRejection };

const AGGREGATES = new Set<SyncAggregate>(['entry', 'prescription', 'profile']);

function entityId(sourceId: string): string {
  const index = sourceId.lastIndexOf(':');
  return index >= 0 ? sourceId.slice(index + 1) : sourceId;
}

function sourceAggregate(sourceId: string): string | undefined {
  const parts = sourceId.split(':');
  return parts.length >= 2 ? parts.at(-2) : undefined;
}

function envelope(
  aggregate: SyncAggregate,
  op: SyncOperation,
  record: unknown,
): SyncEnvelope {
  return { aggregate, op, record };
}

function decode(input: {
  sourceId: string;
  envelope: unknown;
  protocolVersion?: number;
  schemaVersion?: number;
  encryptionVersion?: number;
}): SyncChangeDecodeResult {
  const candidate = input.envelope as Partial<SyncEnvelope> | null;
  if (!candidate?.aggregate || !AGGREGATES.has(candidate.aggregate)) {
    return { accepted: false, reason: 'aggregate' };
  }
  if (candidate.op !== 'upsert' && candidate.op !== 'delete') {
    return { accepted: false, reason: 'operation' };
  }
  if (sourceAggregate(input.sourceId) !== candidate.aggregate) {
    return { accepted: false, reason: 'entity-identity' };
  }
  if (input.protocolVersion !== undefined && input.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    return { accepted: false, reason: 'protocol-version' };
  }
  if (
    input.schemaVersion !== undefined
    && (!Number.isInteger(input.schemaVersion)
      || input.schemaVersion < 1
      || input.schemaVersion > DB_SCHEMA_VERSION)
  ) {
    return { accepted: false, reason: 'schema-version' };
  }
  if (
    input.encryptionVersion !== undefined
    && input.encryptionVersion !== ENCRYPTION_FORMAT_VERSION
  ) {
    return { accepted: false, reason: 'encryption-version' };
  }
  const decoded: DecodedSyncChange = {
    aggregate: candidate.aggregate,
    entityId: entityId(input.sourceId),
    op: candidate.op,
    record: candidate.record ?? null,
  };
  if (decoded.aggregate === 'profile' && decoded.entityId !== 'profile') {
    return { accepted: false, reason: 'entity-identity' };
  }
  if (decoded.op === 'upsert') {
    if (!decoded.record || typeof decoded.record !== 'object' || Array.isArray(decoded.record)) {
      return { accepted: false, reason: 'payload' };
    }
    if ((decoded.record as { id?: unknown }).id !== decoded.entityId) {
      return { accepted: false, reason: 'entity-identity' };
    }
  }
  return { accepted: true, change: decoded };
}

function decodeEnvelope(sourceId: string, value: unknown): DecodedSyncChange {
  const result = decode({ sourceId, envelope: value });
  if (!result.accepted) {
    throw new Error(`Sync row ${sourceId} was rejected: ${result.reason}.`);
  }
  return result.change;
}

function fromRecord(input: {
  aggregate: SyncAggregate;
  op: SyncOperation;
  record: unknown;
  sourceId: string;
  sourceUpdatedAt: string;
  protocolVersion: number;
  schemaVersion: number;
  encryptionVersion?: number;
}): PlainSyncChange {
  const decoded = decode({
    sourceId: input.sourceId,
    envelope: envelope(input.aggregate, input.op, input.record),
    protocolVersion: input.protocolVersion,
    schemaVersion: input.schemaVersion,
    encryptionVersion: input.encryptionVersion,
  });
  if (!decoded.accepted) {
    throw new Error(`Canonical sync change ${input.sourceId} was rejected: ${decoded.reason}.`);
  }
  const record = input.record as { updatedAt?: string } | null | undefined;
  return {
    id: `${decoded.change.aggregate}:${decoded.change.entityId}`,
    aggregate: input.aggregate,
    op: input.op,
    payload: input.record,
    protocolVersion: input.protocolVersion,
    schemaVersion: input.schemaVersion,
    createdAt: record?.updatedAt ?? input.sourceUpdatedAt,
  };
}

function dedupe(changes: PlainSyncChange[]): PlainSyncChange[] {
  return [...new Map(
    [...changes]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((change) => [change.id, change] as const),
  ).values()];
}

export const canonicalSyncChange = { entityId, envelope, decode, decodeEnvelope, fromRecord, dedupe };

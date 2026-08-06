import type { SyncAggregate } from '$lib/domain/types';
import { DB_SCHEMA_VERSION } from '$lib/db/schema';
import { ENCRYPTION_FORMAT_VERSION, encryptRecord } from '$lib/crypto/e2ee';
import { SYNC_PROTOCOL_VERSION, type SyncOperation } from '$lib/sync/protocol';

export type PlainSyncChange = {
  id: string;
  aggregate: SyncAggregate;
  op: SyncOperation;
  payload: unknown;
  protocolVersion: number;
  schemaVersion: number;
  createdAt: string;
  insertedAt?: string;
};

export type SyncEnvelope = {
  aggregate: SyncAggregate;
  op: SyncOperation;
  record: unknown;
};

export type CanonicalSealedChange = {
  id: string;
  ciphertext: string;
  iv: string;
  protocolVersion: number;
  encryptionVersion: number;
  schemaVersion: number;
  createdAt: string;
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

function optionalType(
  record: Record<string, unknown>,
  key: string,
  type: 'string' | 'number' | 'boolean',
): boolean {
  return record[key] == null || typeof record[key] === type;
}

function stringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function stringMap(value: unknown): boolean {
  return value === undefined || (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string')
  );
}

function timestampMap(value: unknown): boolean {
  return value === undefined || (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(isoTimestamp)
  );
}

function validPayloadShape(aggregate: SyncAggregate, value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string'
    || !isoTimestamp(value.createdAt)
    || !isoTimestamp(value.updatedAt)) {
    return false;
  }
  if (!timestampMap(value.fieldUpdatedAt)) return false;
  if (aggregate === 'entry') {
    return isoDate(value.date)
      && optionalType(value, 'weightLbs', 'number')
      && optionalType(value, 'wellness', 'number')
      && optionalType(value, 'amountMg', 'number')
      && optionalType(value, 'notes', 'string')
      && optionalType(value, 'medication', 'string')
      && optionalType(value, 'site', 'string')
      && optionalType(value, 'prescriptionId', 'string')
      && optionalType(value, 'planned', 'boolean')
      && (value.confirmedAt == null || isoTimestamp(value.confirmedAt))
      && optionalType(value, 'skipped', 'boolean')
      && stringArray(value.symptoms);
  }
  if (aggregate === 'prescription') {
    return optionalType(value, 'type', 'string')
      && optionalType(value, 'compoundDate', 'string')
      && optionalType(value, 'refillDate', 'string')
      && optionalType(value, 'bud', 'string')
      && optionalType(value, 'lotNumber', 'string')
      && optionalType(value, 'concentrationMgMl', 'number')
      && optionalType(value, 'vialMl', 'number')
      && optionalType(value, 'prescribedDoseMg', 'number')
      && optionalType(value, 'dosesLeft', 'number')
      && optionalType(value, 'manualMgUsed', 'number')
      && optionalType(value, 'costUsd', 'number')
      && optionalType(value, 'pharmacy', 'string')
      && optionalType(value, 'additive', 'string')
      && optionalType(value, 'status', 'string')
      && optionalType(value, 'sortOrder', 'number')
      && optionalType(value, 'archived', 'boolean');
  }
  return typeof value.passphraseEnabled === 'boolean'
    && optionalType(value, 'startWeight', 'number')
    && optionalType(value, 'goalWeight', 'number')
    && optionalType(value, 'colorTheme', 'string')
    && optionalType(value, 'colorModePreference', 'string')
    && optionalType(value, 'weightUnit', 'string')
    && optionalType(value, 'showArchivedVials', 'boolean')
    && stringArray(value.dosageColOrder)
    && stringArray(value.dosageHiddenCols)
    && stringArray(value.vialColOrder)
    && stringArray(value.vialHiddenCols)
    && stringArray(value.healthColOrder)
    && stringArray(value.healthHiddenCols)
    && stringArray(value.symptomOptions)
    && stringArray(value.shotLocationOptions)
    && stringMap(value.symptomColors);
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
    if (!validPayloadShape(decoded.aggregate, decoded.record as Record<string, unknown>)) {
      return { accepted: false, reason: 'payload' };
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

async function seal(
  change: PlainSyncChange,
  key: string,
  context: Record<string, unknown> = {},
): Promise<CanonicalSealedChange> {
  const decoded = decode({
    sourceId: change.id,
    envelope: envelope(change.aggregate, change.op, change.payload),
    protocolVersion: change.protocolVersion,
    schemaVersion: change.schemaVersion,
    encryptionVersion: ENCRYPTION_FORMAT_VERSION,
  });
  if (!decoded.accepted) {
    throw new Error(`Canonical sync change ${change.id} was rejected: ${decoded.reason}.`);
  }
  const encrypted = await encryptRecord(key, {
    ...context,
    ...envelope(change.aggregate, change.op, change.payload),
  });
  return {
    id: change.id,
    ...encrypted,
    protocolVersion: change.protocolVersion,
    encryptionVersion: ENCRYPTION_FORMAT_VERSION,
    schemaVersion: change.schemaVersion,
    createdAt: change.createdAt,
  };
}

export const canonicalSyncChange = { entityId, envelope, decode, decodeEnvelope, fromRecord, dedupe, seal };

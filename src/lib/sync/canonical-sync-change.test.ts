import { describe, expect, it } from 'vitest';
import { canonicalSyncChange } from './canonical-sync-change';

describe('canonical sync change', () => {
  it('normalizes migration ids and preserves the record LWW clock', () => {
    expect(canonicalSyncChange.fromRecord({
      aggregate: 'entry',
      op: 'upsert',
      record: { id: 'dose-1', updatedAt: '2026-08-06T02:00:00.000Z' },
      sourceId: 'migration-1:entry:dose-1',
      sourceUpdatedAt: '2026-08-06T01:00:00.000Z',
      protocolVersion: 1,
      schemaVersion: 3,
    })).toMatchObject({ id: 'entry:dose-1', createdAt: '2026-08-06T02:00:00.000Z' });
  });

  it('round-trips the shared plain/encrypted envelope', () => {
    const envelope = canonicalSyncChange.envelope('profile', 'delete', null);
    expect(canonicalSyncChange.decodeEnvelope('profile:profile', envelope)).toEqual({
      aggregate: 'profile',
      entityId: 'profile',
      op: 'delete',
      record: null,
    });
  });

  it('deduplicates canonical ids by newest LWW clock', () => {
    const base = {
      id: 'entry:dose-1', aggregate: 'entry' as const, op: 'upsert' as const,
      payload: {}, protocolVersion: 1, schemaVersion: 3,
    };
    expect(canonicalSyncChange.dedupe([
      { ...base, createdAt: '2026-08-06T02:00:00.000Z' },
      { ...base, createdAt: '2026-08-06T01:00:00.000Z' },
    ])).toEqual([{ ...base, createdAt: '2026-08-06T02:00:00.000Z' }]);
  });

  it('classifies identity and metadata rejection before apply', () => {
    expect(canonicalSyncChange.decode({
      sourceId: 'entry:right-id',
      envelope: canonicalSyncChange.envelope('entry', 'upsert', { id: 'wrong-id' }),
      protocolVersion: 1,
      schemaVersion: 3,
      encryptionVersion: 1,
    })).toEqual({ accepted: false, reason: 'entity-identity' });

    expect(canonicalSyncChange.decode({
      sourceId: 'entry:right-id',
      envelope: canonicalSyncChange.envelope('entry', 'upsert', { id: 'right-id' }),
      protocolVersion: 999,
    })).toEqual({ accepted: false, reason: 'protocol-version' });
  });

  it('rejects a source row whose aggregate or entity id differs from its payload', () => {
    expect(canonicalSyncChange.decode({
      sourceId: 'prescription:right-id',
      envelope: canonicalSyncChange.envelope('entry', 'upsert', { id: 'right-id' }),
    })).toEqual({ accepted: false, reason: 'entity-identity' });

    expect(() => canonicalSyncChange.fromRecord({
      aggregate: 'entry',
      op: 'upsert',
      record: { id: 'payload-id' },
      sourceId: 'entry:source-id',
      sourceUpdatedAt: '2026-08-06T01:00:00.000Z',
      protocolVersion: 1,
      schemaVersion: 3,
    })).toThrow(/entity-identity/);
  });
});

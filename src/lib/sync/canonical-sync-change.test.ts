import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/crypto/e2ee', () => ({
  ENCRYPTION_FORMAT_VERSION: 1,
  encryptRecord: async (_key: string, value: unknown) => ({
    ciphertext: JSON.stringify(value), iv: 'iv',
  }),
}));
import { canonicalSyncChange } from './canonical-sync-change';

describe('canonical sync change', () => {
  const timestamps = {
    createdAt: '2026-08-06T01:00:00.000Z',
    updatedAt: '2026-08-06T02:00:00.000Z',
  };

  it('normalizes migration ids and preserves the record LWW clock', () => {
    expect(canonicalSyncChange.fromRecord({
      aggregate: 'entry',
      op: 'upsert',
      record: { id: 'dose-1', date: '2026-08-06', ...timestamps },
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

  it('preserves identity and payload across representative aggregate round trips', () => {
    const records = [
      ['entry', { id: 'dose-1', date: '2026-08-06', notes: null, ...timestamps }],
      ['prescription', { id: 'vial-1', medication: 'Test', ...timestamps }],
      ['profile', { id: 'profile', displayName: 'A', passphraseEnabled: false, ...timestamps }],
    ] as const;

    for (let iteration = 0; iteration < 20; iteration += 1) {
      for (const [aggregate, seed] of records) {
        const record = { ...seed, iteration };
        const sourceId = `${aggregate}:${record.id}`;
        const change = canonicalSyncChange.fromRecord({
          aggregate, op: 'upsert', record, sourceId,
          sourceUpdatedAt: '2026-08-01T00:00:00.000Z', protocolVersion: 1, schemaVersion: 3,
        });
        expect(canonicalSyncChange.decodeEnvelope(change.id,
          canonicalSyncChange.envelope(change.aggregate, change.op, change.payload),
        )).toEqual({ aggregate, entityId: record.id, op: 'upsert', record });
      }
    }
  });

  it('accepts tombstones with null records and rejects null upserts', () => {
    expect(canonicalSyncChange.decode({
      sourceId: 'prescription:vial-1',
      envelope: canonicalSyncChange.envelope('prescription', 'delete', null),
    })).toMatchObject({ accepted: true, change: { entityId: 'vial-1', record: null } });
    expect(canonicalSyncChange.decode({
      sourceId: 'prescription:vial-1',
      envelope: canonicalSyncChange.envelope('prescription', 'upsert', null),
    })).toEqual({ accepted: false, reason: 'payload' });
  });

  it('rejects aggregate payload fields with unsafe runtime shapes', () => {
    expect(canonicalSyncChange.decode({
      sourceId: 'entry:dose-1',
      envelope: canonicalSyncChange.envelope('entry', 'upsert', {
        id: 'dose-1', date: '2026-08-06', ...timestamps,
        weightLbs: 'not-a-number', symptoms: ['ok', 42],
      }),
    })).toEqual({ accepted: false, reason: 'payload' });
    expect(canonicalSyncChange.decode({
      sourceId: 'profile:profile',
      envelope: canonicalSyncChange.envelope('profile', 'upsert', {
        id: 'profile', ...timestamps, passphraseEnabled: 'yes',
      }),
    })).toEqual({ accepted: false, reason: 'payload' });
  });

  it('keeps canonical envelope fields when sealing with conflicting context', async () => {
    const change = canonicalSyncChange.fromRecord({
      aggregate: 'entry', op: 'upsert',
      record: { id: 'dose-1', date: '2026-08-06', ...timestamps },
      sourceId: 'entry:dose-1', sourceUpdatedAt: timestamps.updatedAt,
      protocolVersion: 1, schemaVersion: 3,
    });
    const sealed = await canonicalSyncChange.seal(change, 'key', {
      aggregate: 'profile', op: 'delete', record: null,
    });
    expect(JSON.parse(sealed.ciphertext)).toMatchObject({
      aggregate: 'entry', op: 'upsert', record: { id: 'dose-1' },
    });
  });
});

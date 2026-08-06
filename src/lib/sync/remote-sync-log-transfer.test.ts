import { describe, expect, it, vi } from 'vitest';
import { createRemoteSyncLogTransfer, type EncryptedSyncChange } from './remote-sync-log-transfer';
import { createInMemorySyncLogAdapter } from './sync-log-in-memory-adapter';

vi.mock('$lib/crypto/e2ee', () => ({
  ENCRYPTION_FORMAT_VERSION: 1,
  encryptRecord: async (key: string, value: unknown) => ({
    ciphertext: `${key}:${JSON.stringify(value)}`,
    iv: 'test-iv',
  }),
  decryptRecord: async (key: string, ciphertext: string) => {
    if (!ciphertext.startsWith(`${key}:`)) throw new Error('wrong key');
    return JSON.parse(ciphertext.slice(key.length + 1));
  },
}));

const entryPayload = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  date: '2026-08-06',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
  ...extra,
});

const prescriptionPayload = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
  ...extra,
});

const plainChange = {
  id: 'entry:one',
  aggregate: 'entry' as const,
  op: 'upsert' as const,
  payload: entryPayload('one'),
  protocolVersion: 1,
  schemaVersion: 3,
  createdAt: '2026-08-06T00:00:00.000Z',
};

const encryptedChange: EncryptedSyncChange = {
  id: 'entry:one', ciphertext: 'ciphertext', iv: 'iv', protocolVersion: 1,
  encryptionVersion: 1, dekVersion: 1, schemaVersion: 3,
  createdAt: '2026-08-06T00:00:00.000Z',
};

const migration = () => ({
  id: 'migration-1', direction: 'enable' as const, phase: 'preparing' as const,
  ownerDeviceId: 'device-1', startedAt: plainChange.createdAt, updatedAt: plainChange.createdAt,
});

describe('remote sync-log transfer', () => {
  it('runs canonical steady-state plain transfer through an in-memory adapter', async () => {
    const transfer = createRemoteSyncLogTransfer(createInMemorySyncLogAdapter());
    await transfer.publishPlain([plainChange]);
    await expect(transfer.readPlain()).resolves.toEqual([expect.objectContaining(plainChange)]);
  });

  it('guards and verifies copy-before-delete ordering', async () => {
    const events: string[] = [];
    const memory = createInMemorySyncLogAdapter();
    await memory.writePlain([{
      id: plainChange.id, aggregate: plainChange.aggregate, op: plainChange.op,
      payload: { aggregate: 'entry', op: 'upsert', record: plainChange.payload },
      protocolVersion: 1, schemaVersion: 3,
      createdAt: plainChange.createdAt, insertedAt: plainChange.createdAt,
    }]);
    const transfer = createRemoteSyncLogTransfer({
      ...memory,
      writeEncrypted: async (rows) => { events.push('write-destination'); await memory.writeEncrypted(rows); },
      deleteObservedPlain: async (rows) => {
        events.push('delete-source');
        return memory.deleteObservedPlain(rows);
      },
    }, undefined, {
      checkpoint: async (_migration, phase) => { events.push(phase === 'transferring' ? 'transfer' : 'checkpoint'); },
      assertOwnership: async () => { events.push('ownership'); },
    });

    await transfer.copyEncryptedThenRemovePlain({
      changes: [encryptedChange],
      migration: migration(),
    });

    expect(events).toEqual(['transfer', 'write-destination', 'checkpoint', 'ownership', 'delete-source']);
    expect(memory.snapshot().plain).toEqual([]);
  });

  it('preserves the source when destination writing fails', async () => {
    const memory = createInMemorySyncLogAdapter();
    await memory.writePlain([{
      id: plainChange.id, aggregate: plainChange.aggregate, op: plainChange.op,
      payload: { aggregate: 'entry', op: 'upsert', record: plainChange.payload },
      protocolVersion: 1, schemaVersion: 3,
      createdAt: plainChange.createdAt, insertedAt: plainChange.createdAt,
    }]);
    const deleteObservedPlain = vi.fn(memory.deleteObservedPlain);
    const transfer = createRemoteSyncLogTransfer({
      ...memory,
      writeEncrypted: vi.fn(async () => { throw new Error('offline'); }),
      deleteObservedPlain,
    });

    await expect(transfer.copyEncryptedThenRemovePlain({
      changes: [encryptedChange],
      migration: migration(),
    })).rejects.toThrow('offline');
    expect(deleteObservedPlain).not.toHaveBeenCalled();
    expect(memory.snapshot().plain).toHaveLength(1);
  });

  it('preserves the source when destination completeness cannot be proven', async () => {
    const memory = createInMemorySyncLogAdapter();
    await memory.writePlain([{
      id: plainChange.id, aggregate: plainChange.aggregate, op: plainChange.op,
      payload: { aggregate: 'entry', op: 'upsert', record: plainChange.payload },
      protocolVersion: 1, schemaVersion: 3,
      createdAt: plainChange.createdAt, insertedAt: plainChange.createdAt,
    }]);
    const deleteObservedPlain = vi.fn(memory.deleteObservedPlain);
    const transfer = createRemoteSyncLogTransfer({ ...memory, deleteObservedPlain });

    await expect(transfer.copyEncryptedThenRemovePlain({
      changes: [],
      migration: migration(),
    })).rejects.toThrow(/destination is missing/i);
    expect(deleteObservedPlain).not.toHaveBeenCalled();
  });

  it('preserves a late same-id plaintext edit for the next migration pass', async () => {
    const memory = createInMemorySyncLogAdapter();
    await memory.writePlain([{
      id: plainChange.id, aggregate: plainChange.aggregate, op: plainChange.op,
      payload: { aggregate: 'entry', op: 'upsert', record: plainChange.payload },
      protocolVersion: 1, schemaVersion: 3,
      createdAt: plainChange.createdAt, insertedAt: plainChange.createdAt,
    }]);
    const transfer = createRemoteSyncLogTransfer({
      ...memory,
      deleteObservedPlain: async (rows) => {
        await memory.writePlain([{
          ...memory.snapshot().plain[0],
          payload: {
            aggregate: 'entry', op: 'upsert',
            record: entryPayload('one', { notes: 'late' }),
          },
          createdAt: '2026-08-06T00:01:00.000Z',
          insertedAt: '2026-08-06T00:01:00.000Z',
        }]);
        return memory.deleteObservedPlain(rows);
      },
    });

    await expect(transfer.copyEncryptedThenRemovePlain({
      changes: [encryptedChange], migration: migration(),
    })).rejects.toThrow(/plaintext sync sources remain/i);
    expect(memory.snapshot().plain[0]).toMatchObject({
      id: plainChange.id, createdAt: '2026-08-06T00:01:00.000Z',
    });
  });

  it('preserves a late same-id encrypted edit for the next migration pass', async () => {
    const memory = createInMemorySyncLogAdapter();
    await memory.writeEncrypted([{ ...encryptedChange, insertedAt: encryptedChange.createdAt }]);
    const transfer = createRemoteSyncLogTransfer({
      ...memory,
      deleteObservedEncrypted: async (rows) => {
        await memory.writeEncrypted([{
          ...memory.snapshot().encrypted[0],
          ciphertext: 'late-ciphertext',
          createdAt: '2026-08-06T00:01:00.000Z',
          insertedAt: '2026-08-06T00:01:00.000Z',
        }]);
        return memory.deleteObservedEncrypted(rows);
      },
    });

    await expect(transfer.copyPlainThenRemoveEncrypted({
      changes: [plainChange], migration: migration(),
    })).rejects.toThrow(/encrypted sync sources remain/i);
    expect(memory.snapshot().encrypted[0]).toMatchObject({
      id: encryptedChange.id, createdAt: '2026-08-06T00:01:00.000Z',
    });
  });

  it('orders equal-time rows deterministically and applies an exclusive cursor', async () => {
    const memory = createInMemorySyncLogAdapter();
    const transfer = createRemoteSyncLogTransfer(memory);
    await transfer.publishPlain([
      { ...plainChange, id: 'entry:b', payload: entryPayload('b') },
      { ...plainChange, id: 'entry:a', payload: entryPayload('a') },
    ]);
    expect((await transfer.pullPlain()).map((row) => row.entityId)).toEqual(['a', 'b']);
    await expect(transfer.pullPlain(plainChange.createdAt)).resolves.toEqual([]);
  });

  it('keeps aggregate metadata inside ciphertext and decrypts only the active DEK', async () => {
    const memory = createInMemorySyncLogAdapter();
    const transfer = createRemoteSyncLogTransfer(memory);
    await transfer.publishOutbox({
      rows: [{
        id: 'prescription:vial-1', aggregate: 'prescription', entityId: 'vial-1',
        op: 'upsert', payload: prescriptionPayload('vial-1', { medication: 'Test' }),
        updatedAt: plainChange.createdAt, enqueuedAt: plainChange.createdAt, rev: 'r1',
      }],
      syncMode: 'e2ee', sessionKey: 'DEK-1', dekVersion: 1,
    });
    const stored = memory.snapshot().encrypted[0];
    expect(stored).not.toHaveProperty('aggregate');
    expect(stored.ciphertext).not.toContain('prescription:vial-1');
    await expect(transfer.pullEncrypted(null, 'DEK-1', 1)).resolves.toEqual([
      expect.objectContaining({ aggregate: 'prescription', entityId: 'vial-1' }),
    ]);
    await expect(transfer.pullEncrypted(null, 'DEK-2', 2)).resolves.toEqual([]);
  });

  it('re-encrypts every old-version row and resumes idempotently', async () => {
    const memory = createInMemorySyncLogAdapter();
    const transfer = createRemoteSyncLogTransfer(memory);
    await transfer.publishOutbox({
      rows: [{
        id: 'entry:one', aggregate: 'entry', entityId: 'one', op: 'upsert',
        payload: entryPayload('one'), updatedAt: plainChange.createdAt,
        enqueuedAt: plainChange.createdAt, rev: 'r1',
      }],
      syncMode: 'e2ee', sessionKey: 'OLD', dekVersion: 1,
    });
    await expect(transfer.rotateCiphertext({
      oldDek: 'OLD', oldVersion: 1, newDek: 'NEW', newVersion: 2,
    })).resolves.toBe(1);
    await expect(transfer.rotateCiphertext({
      oldDek: 'OLD', oldVersion: 1, newDek: 'NEW', newVersion: 2,
    })).resolves.toBe(0);
    await expect(transfer.pullEncrypted(null, 'NEW', 2)).resolves.toEqual([
      expect.objectContaining({ entityId: 'one' }),
    ]);
  });

  it('preserves source when ownership changes before delete', async () => {
    const memory = createInMemorySyncLogAdapter();
    await memory.writePlain([{
      id: plainChange.id, aggregate: plainChange.aggregate, op: plainChange.op,
      payload: { aggregate: 'entry', op: 'upsert', record: plainChange.payload },
      protocolVersion: 1, schemaVersion: 3,
      createdAt: plainChange.createdAt, insertedAt: plainChange.createdAt,
    }]);
    const transfer = createRemoteSyncLogTransfer(memory, undefined, {
      checkpoint: async () => undefined,
      assertOwnership: async () => { throw new Error('superseded'); },
    });
    await expect(transfer.copyEncryptedThenRemovePlain({
      changes: [encryptedChange], migration: migration(),
    })).rejects.toThrow('superseded');
    expect(memory.snapshot().plain).toHaveLength(1);
  });

  it('classifies opposite-mode races through the in-memory production port', async () => {
    const memory = createInMemorySyncLogAdapter();
    memory.rejectNextWrite({ code: '42501' });
    const transfer = createRemoteSyncLogTransfer(
      memory,
      undefined,
      undefined,
      async () => ({ syncMode: 'e2ee' }),
    );

    await expect(transfer.publishSteadyStateOutbox({
      rows: [{
        id: 'entry:one', aggregate: 'entry', entityId: 'one', op: 'upsert',
        payload: entryPayload('one'), updatedAt: plainChange.createdAt,
        enqueuedAt: plainChange.createdAt, rev: 'r1',
      }],
      syncMode: 'plain', dekVersion: 1,
    })).resolves.toMatchObject({ pushed: 0, modeRejected: true });
  });

  it('models server LWW by refusing to replace a newer row with an older write', async () => {
    const memory = createInMemorySyncLogAdapter();
    const transfer = createRemoteSyncLogTransfer(memory);
    await transfer.publishPlain([plainChange]);
    await transfer.publishPlain([{
      ...plainChange,
      payload: entryPayload('one', { notes: 'stale' }),
      createdAt: '2026-08-05T00:00:00.000Z',
    }]);

    await expect(transfer.readPlain()).resolves.toEqual([
      expect.objectContaining({ payload: plainChange.payload, createdAt: plainChange.createdAt }),
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createRemoteSyncLogTransfer, type RemoteSyncLogPort } from './remote-sync-log-transfer';
import type { PlainSyncChange } from './canonical-sync-change';

function port(events: string[]): RemoteSyncLogPort {
  return {
    absorbSnapshot: vi.fn(async () => ({ fetched: 0, applied: 0 })),
    pushEncrypted: vi.fn(async () => { events.push('write-destination'); return { pushed: 2 }; }),
    pushPlain: vi.fn(async () => ({ pushed: 0 })),
    fetchPlain: vi.fn(async () => []),
    fetchEncrypted: vi.fn(async () => []),
    deletePlain: vi.fn(async () => { events.push('delete-source'); return { deleted: 2 }; }),
    deleteEncrypted: vi.fn(async () => ({ deleted: 0 })),
    rotateCiphertext: vi.fn(async () => 0),
  };
}

describe('remote sync-log transfer', () => {
  it('guards and verifies copy-before-delete ordering', async () => {
    const events: string[] = [];
    const transfer = createRemoteSyncLogTransfer(port(events));

    await transfer.copyEncryptedThenRemovePlain({
      beforeWrite: async () => { events.push('transfer'); },
      beforeDelete: async () => { events.push('checkpoint'); },
      assertOwnership: async () => { events.push('ownership'); },
    });

    expect(events).toEqual(['transfer', 'write-destination', 'checkpoint', 'ownership', 'delete-source']);
  });

  it('preserves the source when destination writing fails', async () => {
    const events: string[] = [];
    const fake = port(events);
    fake.pushEncrypted = vi.fn(async () => { throw new Error('offline'); });
    const transfer = createRemoteSyncLogTransfer(fake);

    await expect(transfer.copyEncryptedThenRemovePlain({
      beforeWrite: async () => undefined,
      beforeDelete: async () => undefined,
      assertOwnership: async () => undefined,
    })).rejects.toThrow('offline');
    expect(fake.deletePlain).not.toHaveBeenCalled();
  });

  it('preserves the source when destination completeness cannot be proven', async () => {
    const events: string[] = [];
    const fake = port(events);
    fake.fetchPlain = vi.fn(async (): Promise<PlainSyncChange[]> => [{
      id: 'entry:one',
      aggregate: 'entry',
      op: 'upsert',
      payload: { id: 'one' },
      protocolVersion: 1,
      schemaVersion: 3,
      createdAt: '2026-08-06T00:00:00.000Z',
    }]);
    const transfer = createRemoteSyncLogTransfer(fake);

    await expect(transfer.copyEncryptedThenRemovePlain({
      beforeWrite: async () => undefined,
      beforeDelete: async () => undefined,
      assertOwnership: async () => undefined,
    })).rejects.toThrow(/destination is missing/i);
    expect(fake.deletePlain).not.toHaveBeenCalled();
  });
});

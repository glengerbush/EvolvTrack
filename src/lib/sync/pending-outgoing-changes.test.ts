import '../../test/dexie-setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/db/schema';
import { getPendingOutgoingChanges } from './pending-outgoing-changes';

const timestamp = '2026-08-07T12:00:00.000Z';

async function pending(
  id: string,
  aggregate: 'entry' | 'prescription' | 'profile',
  op: 'upsert' | 'delete' = 'upsert',
) {
  await db.outbox.put({
    id: `${aggregate}:${id}`,
    aggregate,
    entityId: id,
    op,
    updatedAt: timestamp,
    payload: op === 'delete' ? null : { id },
    enqueuedAt: timestamp,
    rev: `rev-${id}`,
  });
}

beforeEach(async () => {
  await db.outbox.clear();
});

describe('pending outgoing changes', () => {
  it('groups coalesced changes and deletions in user-facing terms', async () => {
    await pending('entry-1', 'entry');
    await pending('entry-2', 'entry', 'delete');
    await pending('vial-1', 'prescription');
    await pending('profile', 'profile');

    await expect(getPendingOutgoingChanges()).resolves.toEqual({
      total: 4,
      healthEntries: 2,
      vials: 1,
      settings: 1,
    });
  });
});

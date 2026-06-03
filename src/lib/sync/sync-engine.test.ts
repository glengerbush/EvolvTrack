import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';

// All shared state lives in vi.hoisted so it exists before vi.mock factories run.
type Result<T = unknown> = { data: T; error: { message: string } | null };

const h = vi.hoisted(() => {
  const upsertImpl = vi.fn();
  const selectImpl = vi.fn();
  const deleteImpl = vi.fn();
  const fromMock = vi.fn();
  const recordMock = vi.fn();
  const encryptImpl = vi.fn();
  const decryptImpl = vi.fn();
  const applyImpl = vi.fn();
  const state = {
    syncMode: 'e2ee' as 'plain' | 'migrating_to_e2ee' | 'e2ee' | 'migrating_to_plain',
    sessionKey: 'pp' as string | null,
    pullCursor: null as string | null,
  };
  return {
    upsertImpl,
    selectImpl,
    deleteImpl,
    fromMock,
    recordMock,
    encryptImpl,
    decryptImpl,
    applyImpl,
    state,
  };
});

function makeQuery(table: string) {
  return {
    upsert: (rows: unknown, opts: unknown) => h.upsertImpl(table, rows, opts),
    select: (_columns?: string) => {
      const filters: Record<string, unknown> = {};
      const builder = {
        eq(col: string, value: unknown) {
          filters[col] = value;
          return builder;
        },
        gt(col: string, value: unknown) {
          filters[col] = { gt: value };
          return builder;
        },
        order(_col: string, _opts: unknown) {
          return builder;
        },
        limit(_n: number) {
          return builder;
        },
        then(onFulfilled: (v: Result) => unknown, onRejected?: (e: unknown) => unknown) {
          return h.selectImpl(table, filters).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
    delete: () => {
      const filters: Record<string, unknown> = {};
      const builder = {
        eq(col: string, value: unknown) {
          filters[col] = value;
          return builder;
        },
        in(col: string, value: unknown) {
          filters[col] = { in: value };
          return builder;
        },
        then(onFulfilled: (v: Result) => unknown) {
          return h.deleteImpl(table, filters).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

h.fromMock.mockImplementation((table: string) => makeQuery(table));

vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from: (table: string) => h.fromMock(table),
  },
}));

vi.mock('$lib/stores/syncStore', () => ({
  lastSynced: { record: (...args: unknown[]) => h.recordMock(...args) },
}));

vi.mock('$lib/domain/repo', () => ({
  getProfile: vi.fn(async () => ({ syncMode: h.state.syncMode })),
  getProfileSyncMode: (profile: { syncMode?: string } | undefined) =>
    profile?.syncMode ?? 'plain',
  applyRemoteChange: (change: unknown) => h.applyImpl(change),
}));

vi.mock('$lib/crypto/e2ee', () => ({
  ENCRYPTION_FORMAT_VERSION: 1,
  encryptRecord: (keyB64: string, record: unknown) => h.encryptImpl(keyB64, record),
  decryptRecord: (keyB64: string, ciphertext: string, iv: string) =>
    h.decryptImpl(keyB64, ciphertext, iv),
}));

vi.mock('$lib/sync/session-key', () => ({
  getSessionKey: () => h.state.sessionKey,
}));

vi.mock('$lib/sync/pull-cursor', () => ({
  getPullCursor: () => h.state.pullCursor,
  setPullCursor: (cursor: string) => {
    h.state.pullCursor = cursor;
  },
}));

import { db } from '$lib/db/schema';
import {
  deleteRemoteEncryptedChanges,
  fetchRemoteEncryptedChanges,
  pullAndApply,
  pushEncryptedChanges,
  pushOutbox,
  pushPlainChanges,
} from './sync-engine';
import { SYNC_PROTOCOL_VERSION } from './protocol';
import { DB_SCHEMA_VERSION } from '$lib/db/schema';
import type { OutboxEntry } from '$lib/domain/types';

beforeEach(() => {
  h.upsertImpl.mockReset();
  h.selectImpl.mockReset();
  h.deleteImpl.mockReset();
  // fromMock is reset but we re-wire its implementation since mockReset clears it.
  h.fromMock.mockReset();
  h.fromMock.mockImplementation((table: string) => makeQuery(table));
  h.recordMock.mockClear();
  h.encryptImpl.mockReset();
  h.encryptImpl.mockImplementation(async (_keyB64: string, record: unknown) => ({
    ciphertext: `ct:${JSON.stringify(record)}`,
    iv: 'iv',
  }));
  h.decryptImpl.mockReset();
  h.applyImpl.mockReset();
  h.applyImpl.mockResolvedValue(true);
  h.state.syncMode = 'e2ee';
  h.state.sessionKey = 'pp';
  h.state.pullCursor = null;
  h.upsertImpl.mockResolvedValue({ data: null, error: null });
  h.selectImpl.mockResolvedValue({ data: [], error: null });
  h.deleteImpl.mockResolvedValue({ data: null, error: null });
});

async function seedOutbox(id: string, overrides: Partial<OutboxEntry> = {}) {
  const [aggregate, entityId] = id.split(':');
  await db.outbox.put({
    id,
    aggregate: aggregate as OutboxEntry['aggregate'],
    entityId: entityId ?? id,
    op: 'upsert',
    updatedAt: '2026-05-01T00:00:00.000Z',
    payload: { value: id },
    enqueuedAt: '2026-05-01T00:00:00.000Z',
    rev: `rev-${id}`,
    ...overrides,
  });
}

async function seedMigrationBackfill(id: string, aggregate: 'weight' | 'injection' = 'weight') {
  await db.migrationBackfill.put({
    id,
    aggregate,
    op: 'upsert',
    payloadCiphertext: `ct-${id}`,
    payloadIv: `iv-${id}`,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    encryptionVersion: 1,
    schemaVersion: DB_SCHEMA_VERSION,
    createdAt: '2026-05-01T00:00:00.000Z',
  });
}

describe('pushEncryptedChanges — guard conditions', () => {
  it('refuses to push when sync mode is plain', async () => {
    h.state.syncMode = 'plain';
    await expect(pushEncryptedChanges()).rejects.toThrow(/Enable E2EE/);
    expect(h.upsertImpl).not.toHaveBeenCalled();
  });

  it('refuses to push during an enable-migration unless allowMigrating is set', async () => {
    h.state.syncMode = 'migrating_to_e2ee';
    await expect(pushEncryptedChanges()).rejects.toThrow(/migration is in progress/i);
  });

  it('refuses to push during a disable-migration', async () => {
    h.state.syncMode = 'migrating_to_plain';
    await expect(pushEncryptedChanges()).rejects.toThrow(/disable is in progress/i);
  });

  it('returns { pushed: 0 } when there are no events to send', async () => {
    h.state.syncMode = 'e2ee';
    const result = await pushEncryptedChanges();
    expect(result).toEqual({ pushed: 0 });
    expect(h.upsertImpl).not.toHaveBeenCalled();
  });
});

describe('pushEncryptedChanges — happy path', () => {
  it('maps migration-backfill rows to snake_case payload rows and upserts them', async () => {
    await seedMigrationBackfill('evt-1');
    await seedMigrationBackfill('evt-2', 'injection');

    const result = await pushEncryptedChanges();

    expect(result).toEqual({ pushed: 2 });
    expect(h.upsertImpl).toHaveBeenCalledTimes(1);
    const [table, rows, opts] = h.upsertImpl.mock.calls[0];
    expect(table).toBe('sync_changes_encrypted');
    expect(opts).toEqual({ onConflict: 'user_id,id' });
    expect(rows).toHaveLength(2);
    expect((rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'evt-1',
      user_id: 'user-1',
      ciphertext: 'ct-evt-1',
      iv: 'iv-evt-1',
    });
    // aggregate/op live inside the ciphertext only — leaking them in plaintext
    // columns would let the server tally per-kind volume per user.
    const wireRow = (rows as Array<Record<string, unknown>>)[0];
    expect(wireRow).not.toHaveProperty('aggregate');
    expect(wireRow).not.toHaveProperty('op');
    // A single migration push step is not a completed sync: "Last synced" is
    // stamped only when the migration finishes (finishE2EE*Migration) or a
    // steady-state cycle completes (the orchestrator), never per push step.
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it('allows push during migrating_to_e2ee when allowMigrating=true', async () => {
    h.state.syncMode = 'migrating_to_e2ee';
    await seedMigrationBackfill('evt-mig');
    const result = await pushEncryptedChanges({ allowMigrating: true });
    expect(result.pushed).toBe(1);
  });

  it('propagates supabase errors and does not record a successful sync', async () => {
    await seedMigrationBackfill('evt-1');
    h.upsertImpl.mockResolvedValueOnce({ data: null, error: { message: 'rls-denied' } });
    await expect(pushEncryptedChanges()).rejects.toMatchObject({ message: 'rls-denied' });
    expect(h.recordMock).not.toHaveBeenCalled();
  });
});

describe('pushPlainChanges', () => {
  it('returns { pushed: 0 } when given no changes and skips the network', async () => {
    const result = await pushPlainChanges([]);
    expect(result).toEqual({ pushed: 0 });
    expect(h.upsertImpl).not.toHaveBeenCalled();
  });

  it('maps PlainSyncChange fields onto snake_case rows for sync_changes_plain', async () => {
    const result = await pushPlainChanges([
      {
        id: 'p-1',
        aggregate: 'weight',
        op: 'upsert',
        payload: { weightLbs: 180 },
        protocolVersion: SYNC_PROTOCOL_VERSION,
        schemaVersion: DB_SCHEMA_VERSION,
        createdAt: '2026-05-05T00:00:00.000Z',
      },
    ]);

    expect(result).toEqual({ pushed: 1 });
    const [table, rows, opts] = h.upsertImpl.mock.calls[0];
    expect(table).toBe('sync_changes_plain');
    expect(opts).toEqual({ onConflict: 'user_id,id' });
    expect((rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'p-1',
      user_id: 'user-1',
      aggregate: 'weight',
      // Wrapped in the same `{ aggregate, op, record }` envelope steady-state
      // uses, so `pullPlain` can recover the record (the bare-record shape was
      // the disable-migration bug that decoded back to a null upsert).
      payload: { aggregate: 'weight', op: 'upsert', record: { weightLbs: 180 } },
      protocol_version: SYNC_PROTOCOL_VERSION,
      schema_version: DB_SCHEMA_VERSION,
    });
    // Not a completed sync — recording is owned by migration completion / the
    // orchestrator cycle, not this per-step push.
    expect(h.recordMock).not.toHaveBeenCalled();
  });
});

describe('deleteRemoteEncryptedChanges', () => {
  it('deletes all rows for the user when no ids are given', async () => {
    const result = await deleteRemoteEncryptedChanges();
    expect(result).toEqual({ deleted: 0 });
    expect(h.deleteImpl).toHaveBeenCalledTimes(1);
    const [table, filters] = h.deleteImpl.mock.calls[0];
    expect(table).toBe('sync_changes_encrypted');
    expect(filters).toEqual({ user_id: 'user-1' });
  });

  it('scopes the delete by id list when one is provided and returns its size', async () => {
    const result = await deleteRemoteEncryptedChanges(['a', 'b', 'c']);
    expect(result).toEqual({ deleted: 3 });
    const [, filters] = h.deleteImpl.mock.calls[0];
    expect(filters).toEqual({ user_id: 'user-1', id: { in: ['a', 'b', 'c'] } });
    // A delete step within a migration is not itself a completed sync.
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it('throws and skips lastSynced when supabase reports an error', async () => {
    h.deleteImpl.mockResolvedValueOnce({ data: null, error: { message: 'fail' } });
    await expect(deleteRemoteEncryptedChanges(['x'])).rejects.toMatchObject({ message: 'fail' });
    expect(h.recordMock).not.toHaveBeenCalled();
  });
});

describe('fetchRemoteEncryptedChanges', () => {
  it('returns an empty array when the table is empty', async () => {
    h.selectImpl.mockResolvedValueOnce({ data: [], error: null });
    const rows = await fetchRemoteEncryptedChanges();
    expect(rows).toEqual([]);
  });

  it('maps snake_case columns back into camelCase EncryptedSyncChange shape (no aggregate/op leak)', async () => {
    h.selectImpl.mockResolvedValueOnce({
      data: [
        {
          id: 'r-1',
          ciphertext: 'ct',
          iv: 'iv',
          protocol_version: 1,
          encryption_version: 1,
          schema_version: 4,
          created_at: '2026-05-09T00:00:00.000Z',
        },
      ],
      error: null,
    });

    const rows = await fetchRemoteEncryptedChanges();
    expect(rows).toEqual([
      {
        id: 'r-1',
        ciphertext: 'ct',
        iv: 'iv',
        protocolVersion: 1,
        encryptionVersion: 1,
        schemaVersion: 4,
        createdAt: '2026-05-09T00:00:00.000Z',
      },
    ]);
  });

  it('throws on a supabase select error', async () => {
    h.selectImpl.mockResolvedValueOnce({ data: null, error: { message: 'oops' } });
    await expect(fetchRemoteEncryptedChanges()).rejects.toMatchObject({ message: 'oops' });
  });

  it('treats null data as an empty list', async () => {
    h.selectImpl.mockResolvedValueOnce({ data: null, error: null });
    const rows = await fetchRemoteEncryptedChanges();
    expect(rows).toEqual([]);
  });
});

describe('pushOutbox', () => {
  it('returns { pushed: 0 } and skips the network when the outbox is empty', async () => {
    h.state.syncMode = 'plain';
    const result = await pushOutbox();
    expect(result).toEqual({ pushed: 0 });
    expect(h.upsertImpl).not.toHaveBeenCalled();
  });

  it('pauses with skipped=migration-in-progress during an E2EE migration', async () => {
    h.state.syncMode = 'migrating_to_e2ee';
    await seedOutbox('weight:w1');

    const result = await pushOutbox();

    expect(result).toEqual({ pushed: 0, skipped: 'migration-in-progress' });
    expect(h.upsertImpl).not.toHaveBeenCalled();
    expect(await db.outbox.count()).toBe(1); // left intact for after the migration
  });

  it('plain mode upserts enveloped payloads to sync_changes_plain and clears the outbox', async () => {
    h.state.syncMode = 'plain';
    await seedOutbox('weight:w1', { payload: { weightLbs: 180 } });
    await seedOutbox('injection:i1', { aggregate: 'injection', op: 'delete', payload: null });

    const result = await pushOutbox();

    expect(result).toEqual({ pushed: 2 });
    const [table, rows, opts] = h.upsertImpl.mock.calls[0];
    expect(table).toBe('sync_changes_plain');
    expect(opts).toEqual({ onConflict: 'user_id,id' });

    const byId = Object.fromEntries(
      (rows as Array<Record<string, unknown>>).map((r) => [r.id, r]),
    );
    expect(byId['weight:w1']).toMatchObject({
      user_id: 'user-1',
      aggregate: 'weight',
      op: 'upsert',
      payload: { aggregate: 'weight', op: 'upsert', record: { weightLbs: 180 } },
    });
    // A delete tombstone still carries a non-null envelope (the remote
    // payload column is NOT NULL); the record inside it is null.
    expect(byId['injection:i1']).toMatchObject({
      op: 'delete',
      payload: { aggregate: 'injection', op: 'delete', record: null },
    });

    expect(await db.outbox.count()).toBe(0);
    // pushOutbox no longer records "last synced" — that's the orchestrator's
    // job (a clean cycle is a sync even when no rows move). The engine only
    // moves data.
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it('never encrypts or touches sync_changes_encrypted in plain mode', async () => {
    h.state.syncMode = 'plain';
    await seedOutbox('weight:w1');
    await pushOutbox();
    expect(h.encryptImpl).not.toHaveBeenCalled();
    expect(h.fromMock).not.toHaveBeenCalledWith('sync_changes_encrypted');
  });

  it('e2ee mode encrypts each envelope and upserts ciphertext to sync_changes_encrypted', async () => {
    h.state.syncMode = 'e2ee';
    await seedOutbox('weight:w1', { payload: { weightLbs: 180 } });

    const result = await pushOutbox();

    expect(result).toEqual({ pushed: 1 });
    expect(h.encryptImpl).toHaveBeenCalledTimes(1);
    const [keyB64, envelope] = h.encryptImpl.mock.calls[0];
    expect(keyB64).toBe('pp');
    expect(envelope).toEqual({ aggregate: 'weight', op: 'upsert', record: { weightLbs: 180 } });

    const [table, rows] = h.upsertImpl.mock.calls[0];
    expect(table).toBe('sync_changes_encrypted');
    const row = (rows as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ id: 'weight:w1', user_id: 'user-1', iv: 'iv' });
    expect(row.ciphertext).toContain('ct:');
    // The plaintext payload must never ride along on an encrypted row.
    expect(row).not.toHaveProperty('payload');
    // aggregate/op are inside the encrypted envelope, not on the wire row —
    // otherwise the server can tally per-aggregate volume per user.
    expect(row).not.toHaveProperty('aggregate');
    expect(row).not.toHaveProperty('op');
    expect(await db.outbox.count()).toBe(0);
  });

  it('pauses with skipped=locked in e2ee mode when the session has no key', async () => {
    h.state.syncMode = 'e2ee';
    h.state.sessionKey = null;
    await seedOutbox('weight:w1');

    const result = await pushOutbox();

    expect(result).toEqual({ pushed: 0, skipped: 'locked' });
    expect(h.upsertImpl).not.toHaveBeenCalled();
    expect(h.encryptImpl).not.toHaveBeenCalled();
    expect(await db.outbox.count()).toBe(1); // intact; retried after unlock
  });

  it('leaves the outbox intact and records no sync when the upsert fails', async () => {
    h.state.syncMode = 'plain';
    await seedOutbox('weight:w1');
    h.upsertImpl.mockResolvedValueOnce({ data: null, error: { message: 'rls-denied' } });

    await expect(pushOutbox()).rejects.toMatchObject({ message: 'rls-denied' });
    expect(await db.outbox.count()).toBe(1);
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it('preserves a row re-edited mid-push via the rev guard', async () => {
    h.state.syncMode = 'plain';
    await seedOutbox('weight:w1', { rev: 'rev-old' });
    // Simulate a concurrent local edit landing while the upsert is in flight:
    // the same entity is re-enqueued with a fresh rev.
    h.upsertImpl.mockImplementationOnce(async () => {
      await db.outbox.put({
        id: 'weight:w1',
        aggregate: 'weight',
        entityId: 'w1',
        op: 'upsert',
        updatedAt: '2026-05-02T00:00:00.000Z',
        payload: { weightLbs: 999 },
        enqueuedAt: '2026-05-02T00:00:00.000Z',
        rev: 'rev-new',
      });
      return { data: null, error: null };
    });

    const result = await pushOutbox();

    expect(result).toEqual({ pushed: 1 });
    // The re-edited row survived because its rev no longer matched.
    const remaining = await db.outbox.get('weight:w1');
    expect(remaining?.rev).toBe('rev-new');
  });
});

describe('pullAndApply', () => {
  it('pauses with skipped=migration-in-progress during an E2EE migration', async () => {
    h.state.syncMode = 'migrating_to_plain';
    const result = await pullAndApply();
    expect(result).toEqual({ fetched: 0, applied: 0, skipped: 'migration-in-progress' });
    expect(h.selectImpl).not.toHaveBeenCalled();
  });

  it('pauses with skipped=locked in e2ee mode when the session is locked', async () => {
    h.state.syncMode = 'e2ee';
    h.state.sessionKey = null;
    const result = await pullAndApply();
    expect(result).toEqual({ fetched: 0, applied: 0, skipped: 'locked' });
    expect(h.selectImpl).not.toHaveBeenCalled();
  });

  it('returns zero and leaves the cursor untouched when nothing is new', async () => {
    h.state.syncMode = 'plain';
    h.state.pullCursor = '2026-05-01T00:00:00.000Z';
    h.selectImpl.mockResolvedValueOnce({ data: [], error: null });

    const result = await pullAndApply();

    expect(result).toEqual({ fetched: 0, applied: 0 });
    expect(h.state.pullCursor).toBe('2026-05-01T00:00:00.000Z');
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it('plain mode: decodes envelopes, applies each event, and advances the cursor', async () => {
    h.state.syncMode = 'plain';
    h.selectImpl.mockResolvedValueOnce({
      data: [
        {
          id: 'weight:w1',
          aggregate: 'weight',
          op: 'upsert',
          payload: { aggregate: 'weight', op: 'upsert', record: { id: 'w1', weightLbs: 180 } },
          created_at: '2026-05-10T00:00:00.000Z',
          inserted_at: '2026-05-10T00:00:01.000Z',
        },
        {
          id: 'injection:i1',
          aggregate: 'injection',
          op: 'delete',
          payload: { aggregate: 'injection', op: 'delete', record: null },
          created_at: '2026-05-10T00:01:00.000Z',
          inserted_at: '2026-05-10T00:01:01.000Z',
        },
      ],
      error: null,
    });

    const result = await pullAndApply();

    expect(result).toEqual({ fetched: 2, applied: 2 });
    expect(h.fromMock).toHaveBeenCalledWith('sync_changes_plain');
    expect(h.applyImpl).toHaveBeenCalledTimes(2);
    expect(h.applyImpl.mock.calls[0][0]).toMatchObject({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'upsert',
      record: { id: 'w1', weightLbs: 180 },
      remoteUpdatedAt: '2026-05-10T00:00:00.000Z',
    });
    expect(h.applyImpl.mock.calls[1][0]).toMatchObject({
      aggregate: 'injection',
      entityId: 'i1',
      op: 'delete',
      record: null,
      remoteUpdatedAt: '2026-05-10T00:01:00.000Z',
    });
    // Cursor advanced to the last row's inserted_at.
    expect(h.state.pullCursor).toBe('2026-05-10T00:01:01.000Z');
    // pullAndApply no longer records "last synced" — the orchestrator owns
    // that, so a no-op cycle still counts as a sync. The engine only moves data.
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it('passes the existing cursor as a `gt` filter for incremental pulls', async () => {
    h.state.syncMode = 'plain';
    h.state.pullCursor = '2026-05-09T00:00:00.000Z';
    h.selectImpl.mockResolvedValueOnce({ data: [], error: null });

    await pullAndApply();

    const [table, filters] = h.selectImpl.mock.calls[0];
    expect(table).toBe('sync_changes_plain');
    expect(filters).toMatchObject({
      user_id: 'user-1',
      inserted_at: { gt: '2026-05-09T00:00:00.000Z' },
    });
  });

  it('counts only events that actually changed local state', async () => {
    h.state.syncMode = 'plain';
    h.selectImpl.mockResolvedValueOnce({
      data: [
        {
          id: 'weight:w1',
          aggregate: 'weight',
          op: 'upsert',
          payload: { aggregate: 'weight', op: 'upsert', record: { id: 'w1' } },
          created_at: '2026-05-10T00:00:00.000Z',
          inserted_at: '2026-05-10T00:00:01.000Z',
        },
        {
          id: 'weight:w2',
          aggregate: 'weight',
          op: 'upsert',
          payload: { aggregate: 'weight', op: 'upsert', record: { id: 'w2' } },
          created_at: '2026-05-10T00:00:02.000Z',
          inserted_at: '2026-05-10T00:00:03.000Z',
        },
      ],
      error: null,
    });
    // First event applies, second loses LWW.
    h.applyImpl.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await pullAndApply();

    expect(result).toEqual({ fetched: 2, applied: 1 });
  });

  it('e2ee mode: pulls from sync_changes_encrypted, decrypts each row, and applies it', async () => {
    h.state.syncMode = 'e2ee';
    h.selectImpl.mockResolvedValueOnce({
      data: [
        {
          id: 'weight:w1',
          aggregate: 'weight',
          op: 'upsert',
          ciphertext: 'ct',
          iv: 'iv',
          created_at: '2026-05-10T00:00:00.000Z',
          inserted_at: '2026-05-10T00:00:01.000Z',
        },
      ],
      error: null,
    });
    h.decryptImpl.mockResolvedValueOnce({
      aggregate: 'weight',
      op: 'upsert',
      record: { id: 'w1', weightLbs: 200 },
    });

    const result = await pullAndApply();

    expect(result).toEqual({ fetched: 1, applied: 1 });
    expect(h.fromMock).toHaveBeenCalledWith('sync_changes_encrypted');
    expect(h.decryptImpl).toHaveBeenCalledWith('pp', 'ct', 'iv');
    expect(h.applyImpl.mock.calls[0][0]).toMatchObject({
      aggregate: 'weight',
      entityId: 'w1',
      record: { id: 'w1', weightLbs: 200 },
    });
  });

  it('throws and does not advance the cursor on a supabase select error', async () => {
    h.state.syncMode = 'plain';
    h.state.pullCursor = 'cursor-before';
    h.selectImpl.mockResolvedValueOnce({ data: null, error: { message: 'rls-denied' } });

    await expect(pullAndApply()).rejects.toMatchObject({ message: 'rls-denied' });
    expect(h.state.pullCursor).toBe('cursor-before');
    expect(h.applyImpl).not.toHaveBeenCalled();
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { db } from '$lib/db/schema';
import { addEntry, updateEntry, deleteEntry, applyRemoteChange } from '$lib/domain/health-data-storage';
import { createInMemorySyncLogAdapter, type InMemorySyncLogAdapter } from './sync-log-in-memory-adapter';
import type { SyncLogAdapter } from './sync-log-adapter';
import { remoteSyncLogTransfer } from './remote-sync-log-transfer';
import type { WorkerAction, WorkerPayloadMap, WorkerRequest, WorkerResponse } from '$lib/crypto/worker-messages';

// Replace HTTP and the worker message transport, while running the real crypto
// worker, storage, envelopes, acknowledgments and incoming conflict resolution.
const h = vi.hoisted(() => ({
  remote: null as InMemorySyncLogAdapter | null,
  worker: { onmessage: null as ((event: { data: WorkerRequest }) => Promise<void>) | null, postMessage: (_response: WorkerResponse<WorkerAction>) => {} },
}));
vi.mock('$lib/crypto/worker-client', () => ({
  cryptoWorker: {
    async call(type: WorkerAction, payload: WorkerPayloadMap[WorkerAction]) {
      let response!: WorkerResponse<WorkerAction>;
      h.worker.postMessage = (message) => { response = message; };
      await h.worker.onmessage!({ data: { id: 'offline-test', type, payload } as WorkerRequest });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    },
  },
}));
beforeAll(async () => {
  vi.stubGlobal('self', h.worker);
  await import('$lib/workers/crypto.worker');
});
vi.mock('$lib/sync/sync-log-supabase-adapter', () => ({
  supabaseSyncLogAdapter: new Proxy({} as SyncLogAdapter, {
    get: (_target, property) => (...args: unknown[]) => Reflect.apply(Reflect.get(h.remote!, property), h.remote, args),
  }),
}));

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
beforeEach(() => { h.remote = createInMemorySyncLogAdapter(); });

for (const mode of ['plain', 'e2ee'] as const) {
  const publish = async () => remoteSyncLogTransfer.publishSteadyStateOutbox({
    rows: await db.outbox.toArray(), syncMode: mode, sessionKey: key, dekVersion: 1,
  });
  const pull = () => mode === 'plain'
    ? remoteSyncLogTransfer.pullPlain()
    : remoteSyncLogTransfer.pullEncrypted(null, key, 1);

  describe(`offline lifecycle (${mode})`, () => {
    it('persists coalesced edits across reopening and retries a failed upload without data loss', async () => {
      const entry = await addEntry({ date: iso('2026-11-22'), wellness: 5, symptoms: ['Nausea'] });
      await updateEntry(entry.id, { wellness: 8, symptoms: ['Nausea', 'Fatigue'] });
      const queued = await db.outbox.toArray();
      expect(queued).toHaveLength(1);
      db.close();
      await db.open();
      h.remote!.rejectNextWrite(new TypeError('Failed to fetch'));
      await expect(publish()).rejects.toThrow('Failed to fetch');
      expect(await db.outbox.toArray()).toEqual(queued);
      await publish();
      expect(await db.outbox.count()).toBe(0);
      const changes = await pull();
      expect(changes).toHaveLength(1);
      expect(changes[0].record).toMatchObject({ wellness: 8, symptoms: ['Nausea', 'Fatigue'] });
      for (const change of changes) await applyRemoteChange(change);
      expect(await db.entries.get(entry.id)).toMatchObject({ wellness: 8, symptoms: ['Nausea', 'Fatigue'] });
    });

    it('keeps a delete queued when the original upload finishes late and never resurrects its echo', async () => {
      const entry = await addEntry({ date: iso('2026-11-22'), wellness: 7, symptoms: ['Nausea'] });
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      if (mode === 'plain') {
        const write = h.remote!.writePlain.bind(h.remote);
        vi.spyOn(h.remote!, 'writePlain').mockImplementationOnce(async rows => { started(); await gate; await write(rows); });
      } else {
        const write = h.remote!.writeEncrypted.bind(h.remote);
        vi.spyOn(h.remote!, 'writeEncrypted').mockImplementationOnce(async rows => { started(); await gate; await write(rows); });
      }
      const oldPush = publish();
      await entered;
      await deleteEntry(entry.id);
      const deletion = await db.outbox.get(`entry:${entry.id}`);
      release();
      await oldPush;
      expect(await db.outbox.get(`entry:${entry.id}`)).toEqual(deletion);
      const staleChanges = await pull();
      expect(staleChanges[0].op).toBe('upsert');
      for (const change of staleChanges) expect(await applyRemoteChange(change)).toBe(false);
      expect(await db.entries.get(entry.id)).toBeUndefined();
      h.remote!.rejectNextWrite(new TypeError('offline'));
      await expect(publish()).rejects.toThrow('offline');
      db.close();
      await db.open();
      await publish();
      expect(await db.outbox.count()).toBe(0);
      expect((await pull())[0].op).toBe('delete');
      // A response already in flight can land even after the delete was acked.
      for (const change of staleChanges) expect(await applyRemoteChange(change)).toBe(false);
      expect(await db.entries.get(entry.id)).toBeUndefined();
    });

    it('does not lose a newer edit to an older upload acknowledgment', async () => {
      const entry = await addEntry({ date: iso('2026-11-22'), wellness: 4, symptoms: [] });
      const firstRevision = await db.outbox.toArray();
      await updateEntry(entry.id, { wellness: 9, symptoms: ['Fatigue'] });
      const newerRevision = await db.outbox.toArray();
      await remoteSyncLogTransfer.publishSteadyStateOutbox({
        rows: firstRevision, syncMode: mode, sessionKey: key, dekVersion: 1,
      });
      expect(await db.outbox.toArray()).toEqual(newerRevision);
      await publish();
      expect((await pull())[0].record).toMatchObject({ wellness: 9, symptoms: ['Fatigue'] });
      expect(await db.outbox.count()).toBe(0);
    });
  });
}

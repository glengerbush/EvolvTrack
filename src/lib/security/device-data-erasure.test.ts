// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { get } from 'svelte/store';
import { EvolvTrackDB, db } from '$lib/db/schema';
import { durableGet, durableSet } from '$lib/db/durableKv';
import { asIsoDate } from '$lib/utils/dateKeys';
import { hasSessionKey, setSessionKey } from '$lib/sync/session-key';
import {
  __resetDeviceDataErasureForTests,
  __failNextErasureMarkerWriteForTests,
  beginDeviceDataErasure,
  deviceDataErasureState,
  isDeviceDataErasurePending,
  prepareAccountDeletionErasure,
  resumePendingDeviceDataErasure,
} from './device-data-erasure';

const timestamp = '2026-08-07T12:00:00.000Z';

async function populateAppStorage() {
  await db.open();
  await db.entries.put({
    id: 'health-1',
    date: asIsoDate('2026-08-07')!,
    weightLbs: 180,
    symptoms: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.outbox.put({
    id: 'entry:health-1',
    aggregate: 'entry',
    entityId: 'health-1',
    op: 'upsert',
    updatedAt: timestamp,
    payload: { id: 'health-1' },
    enqueuedAt: timestamp,
    rev: 'rev-1',
  });
  await db.prescriptions.put({ id: 'vial-1', createdAt: timestamp, updatedAt: timestamp });
  await db.profile.put({
    id: 'profile',
    passphraseEnabled: true,
    syncMode: 'e2ee',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.encrypted.put({
    id: 'entry:health-1',
    entity: 'entry',
    ciphertext: 'ciphertext',
    iv: 'iv',
    keyVersion: 1,
    updatedAt: timestamp,
  });
  await db.migrationBackfill.put({
    id: 'entry:health-1',
    aggregate: 'entry',
    op: 'upsert',
    payloadCiphertext: 'ciphertext',
    payloadIv: 'iv',
    protocolVersion: 1,
    encryptionVersion: 1,
    schemaVersion: 1,
    createdAt: timestamp,
  });
  await db.wrappedKeys.put({
    id: 'self',
    dekVersion: 1,
    passphraseSaltB64: 'salt',
    passphraseWrapped: { ciphertext: 'ciphertext', iv: 'iv' },
    passphraseIterations: 1,
    recoveryStatus: 'declined',
    updatedAt: timestamp,
  });
  await durableSet('sb-auth-token', 'SESSION');
  await durableSet('et.session.dek', 'DEK');
  localStorage.setItem('evolvtrack-color-mode', 'dark');
  sessionStorage.setItem('private-session-value', 'present');
}

async function appDatabaseCounts() {
  const reopened = new EvolvTrackDB();
  await reopened.open();
  const counts = await Promise.all(reopened.tables.map((table) => table.count()));
  reopened.close();
  return counts;
}

beforeEach(async () => {
  await __resetDeviceDataErasureForTests();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await __resetDeviceDataErasureForTests();
  localStorage.clear();
  sessionStorage.clear();
});

describe('Device Data Erasure', () => {
  it('removes all app-held data before reporting completion', async () => {
    await populateAppStorage();
    expect(await appDatabaseCounts()).toEqual([1, 1, 1, 1, 1, 1, 1]);

    await beginDeviceDataErasure();

    expect(await isDeviceDataErasurePending()).toBe(false);
    expect(await appDatabaseCounts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(await durableGet('sb-auth-token')).toBeNull();
    expect(await durableGet('et.session.dek')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  }, 15_000);

  it('retains durable pending state when deletion fails', async () => {
    await populateAppStorage();
    vi.spyOn(db, 'delete').mockRejectedValueOnce(new Error('blocked by another tab'));

    await expect(beginDeviceDataErasure()).rejects.toThrow('blocked by another tab');

    expect(await isDeviceDataErasurePending()).toBe(true);
  });

  it('resumes a failed erasure idempotently', async () => {
    await populateAppStorage();
    const deletion = vi.spyOn(db, 'delete').mockRejectedValueOnce(new Error('interrupted'));
    await expect(beginDeviceDataErasure()).rejects.toThrow('interrupted');
    deletion.mockRestore();

    await expect(resumePendingDeviceDataErasure()).resolves.toBe('complete');

    expect(await isDeviceDataErasurePending()).toBe(false);
    expect(await appDatabaseCounts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('does nothing when no erasure is pending', async () => {
    await expect(resumePendingDeviceDataErasure()).resolves.toBe('none');
  });

  it('does not erase a merely prepared account deletion', async () => {
    await populateAppStorage();
    await prepareAccountDeletionErasure();

    await expect(resumePendingDeviceDataErasure()).rejects.toThrow(/must be confirmed/i);

    expect((await appDatabaseCounts())[0]).toBe(1);
    expect(await isDeviceDataErasurePending()).toBe(true);
  });

  it('broadcasts a prepared account deletion so other open tabs enter recovery', async () => {
    const peer = new BroadcastChannel('evolvtrack-device-data-erasure');
    const prepared = new Promise<{ type: string; operationId: string }>((resolve) => {
      peer.addEventListener('message', (event) => {
        const message = event.data as { type: string; operationId: string };
        if (message.type === 'account-deletion-prepared') resolve(message);
      });
    });

    try {
      const id = await prepareAccountDeletionErasure();

      await expect(prepared).resolves.toEqual({
        type: 'account-deletion-prepared',
        operationId: id,
      });
      expect(get(deviceDataErasureState)).toMatchObject({ status: 'erasing' });
    } finally {
      peer.close();
    }
  });

  it('fails closed when its durable marker cannot be written', async () => {
    await populateAppStorage();
    __failNextErasureMarkerWriteForTests('marker unavailable');

    await expect(beginDeviceDataErasure()).rejects.toThrow('marker unavailable');

    expect(get(deviceDataErasureState)).toMatchObject({ status: 'blocked' });
    expect(await db.entries.count()).toBe(1);
  });

  it('retains the marker when web storage cannot be cleared', async () => {
    await populateAppStorage();
    vi.spyOn(localStorage, 'clear').mockImplementationOnce(() => {
      throw new Error('storage denied');
    });

    await expect(beginDeviceDataErasure()).rejects.toThrow('storage denied');

    expect(await isDeviceDataErasurePending()).toBe(true);
  });

  it('retains the marker when durable authentication storage cannot be deleted', async () => {
    await populateAppStorage();
    const originalDelete = Dexie.prototype.delete;
    vi.spyOn(Dexie.prototype, 'delete').mockImplementation(function () {
      if (this.name === 'evolvtrack-auth') return Promise.reject(new Error('auth database blocked'));
      return originalDelete.call(this);
    });

    await expect(beginDeviceDataErasure()).rejects.toThrow('auth database blocked');

    expect(await isDeviceDataErasurePending()).toBe(true);
  });

  it('does not report completion when final deletion verification fails', async () => {
    await populateAppStorage();
    const originalExists = Dexie.exists;
    vi.spyOn(Dexie, 'exists').mockImplementation(async (name) => {
      if (name === 'evolvtrack-auth') return true;
      return originalExists(name);
    });

    await expect(beginDeviceDataErasure()).rejects.toThrow(/could not be verified removed/i);

    expect(await isDeviceDataErasurePending()).toBe(true);
    expect(get(deviceDataErasureState)).toMatchObject({ status: 'blocked' });
  });

  it('requires a discovered tab to acknowledge revocation before deletion', async () => {
    await populateAppStorage();
    const peer = new BroadcastChannel('evolvtrack-device-data-erasure');
    peer.addEventListener('message', (event) => {
      const message = event.data as { type: string; operationId: string };
      if (message.type === 'probe') {
        peer.postMessage({ type: 'present', operationId: message.operationId, tabId: 'peer-tab' });
      }
    });

    try {
      await expect(beginDeviceDataErasure()).rejects.toThrow(/did not release/i);
      expect(await isDeviceDataErasurePending()).toBe(true);
      expect((await appDatabaseCounts())[0]).toBe(1);
    } finally {
      peer.close();
    }
  });

  it('continues after a discovered tab acknowledges revocation', async () => {
    await populateAppStorage();
    const peer = new BroadcastChannel('evolvtrack-device-data-erasure');
    peer.addEventListener('message', (event) => {
      const message = event.data as { type: string; operationId: string };
      if (message.type === 'probe') {
        peer.postMessage({ type: 'present', operationId: message.operationId, tabId: 'peer-tab' });
      } else if (message.type === 'start') {
        peer.postMessage({ type: 'ready', operationId: message.operationId, tabId: 'peer-tab' });
      }
    });

    try {
      await expect(beginDeviceDataErasure()).resolves.toBeUndefined();
      expect(await isDeviceDataErasurePending()).toBe(false);
    } finally {
      peer.close();
    }
  });

  it('receiving a real peer start revokes secrets and closes this tab before acknowledging', async () => {
    await populateAppStorage();
    setSessionKey('IN_MEMORY_DEK');
    const peer = new BroadcastChannel('evolvtrack-device-data-erasure');
    const ready = new Promise<void>((resolve) => {
      peer.addEventListener('message', (event) => {
        const message = event.data as { type: string; operationId: string };
        if (message.type === 'ready' && message.operationId === 'peer-erasure') resolve();
      });
    });

    try {
      peer.postMessage({ type: 'start', operationId: 'peer-erasure' });
      await ready;

      expect(hasSessionKey()).toBe(false);
      expect(await durableGet('sb-auth-token')).toBeNull();
      expect(db.isOpen()).toBe(false);
      expect(get(deviceDataErasureState)).toMatchObject({ status: 'erasing' });
    } finally {
      peer.close();
    }
  });
});

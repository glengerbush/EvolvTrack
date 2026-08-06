import {
  deleteRemoteEncryptedChanges,
  deleteRemotePlainChanges,
  fetchRemoteEncryptedChanges,
  fetchRemotePlainChanges,
  pullSnapshotForMigration,
  pushEncryptedChanges,
  pushPlainChanges,
  reEncryptServerRows,
  type EncryptedSyncChange,
  type ReEncryptProgress,
} from '$lib/sync/sync-engine';
import type { PlainSyncChange } from '$lib/sync/canonical-sync-change';

export type RemoteSyncLogPort = {
  absorbSnapshot(sessionKey: string | null): Promise<{ fetched: number; applied: number }>;
  pushEncrypted(): Promise<{ pushed: number }>;
  pushPlain(changes: PlainSyncChange[]): Promise<{ pushed: number }>;
  fetchPlain(): Promise<PlainSyncChange[]>;
  fetchEncrypted(dekVersion?: number): Promise<EncryptedSyncChange[]>;
  deletePlain(ids?: string[]): Promise<{ deleted: number }>;
  deleteEncrypted(ids?: string[]): Promise<{ deleted: number }>;
  rotateCiphertext(params: {
    oldDek: string;
    oldVersion: number;
    newDek: string;
    newVersion: number;
    onProgress?: ReEncryptProgress;
  }): Promise<number>;
};

/** Transition policy over a substitutable remote-log port. */
export function createRemoteSyncLogTransfer(port: RemoteSyncLogPort) {
  return {
    absorbSnapshot: port.absorbSnapshot,
    publishEncrypted: port.pushEncrypted,
    publishPlain: port.pushPlain,
    readPlain: port.fetchPlain,
    readEncrypted: port.fetchEncrypted,
    removePlain: port.deletePlain,
    removeEncrypted: port.deleteEncrypted,
    rotateCiphertext: port.rotateCiphertext,

    async copyEncryptedThenRemovePlain(options: {
      beforeWrite: () => Promise<void>;
      beforeDelete: () => Promise<void>;
      assertOwnership: () => Promise<void>;
    }) {
      const source = await port.fetchPlain();
      await options.beforeWrite();
      const pushed = await port.pushEncrypted();
      const destinationIds = new Set((await port.fetchEncrypted()).map((change) => change.id));
      const missing = source.filter((change) => !destinationIds.has(change.id));
      if (missing.length > 0) {
        throw new Error(`Encrypted destination is missing ${missing.length} source change(s).`);
      }
      await options.beforeDelete();
      await options.assertOwnership();
      await port.deletePlain();
      if ((await port.fetchPlain()).length > 0) {
        throw new Error('Plaintext sync sources remain after encrypted transfer.');
      }
      return pushed;
    },

    async copyPlainThenRemoveEncrypted(options: {
      changes: PlainSyncChange[];
      beforeWrite: () => Promise<void>;
      beforeDelete: () => Promise<void>;
      assertOwnership: () => Promise<void>;
    }) {
      const source = await port.fetchEncrypted();
      await options.beforeWrite();
      const pushed = await port.pushPlain(options.changes);
      const destinationIds = new Set((await port.fetchPlain()).map((change) => change.id));
      const missing = source.filter((change) => !destinationIds.has(change.id));
      if (missing.length > 0) {
        throw new Error(`Plaintext destination is missing ${missing.length} source change(s).`);
      }
      await options.beforeDelete();
      await options.assertOwnership();
      const deleted = await port.deleteEncrypted();
      if ((await port.fetchEncrypted()).length > 0) {
        throw new Error('Encrypted sync sources remain after plaintext transfer.');
      }
      return { pushed: pushed.pushed, deleted: deleted.deleted };
    },
  };
}

export const remoteSyncLogTransfer = createRemoteSyncLogTransfer({
  absorbSnapshot: (sessionKey) => pullSnapshotForMigration(sessionKey),
  pushEncrypted: () => pushEncryptedChanges({ allowMigrating: true }),
  pushPlain: (changes) => pushPlainChanges(changes),
  fetchPlain: () => fetchRemotePlainChanges(),
  fetchEncrypted: (dekVersion) => fetchRemoteEncryptedChanges(dekVersion),
  deletePlain: (ids) => ids ? deleteRemotePlainChanges(ids) : deleteRemotePlainChanges(),
  deleteEncrypted: (ids) => ids ? deleteRemoteEncryptedChanges(ids) : deleteRemoteEncryptedChanges(),
  rotateCiphertext: (params) => reEncryptServerRows(params),
});

export type RemoteSyncLogTransfer = ReturnType<typeof createRemoteSyncLogTransfer>;

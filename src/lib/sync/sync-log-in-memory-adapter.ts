import type {
  EncryptedSyncLogRow,
  PlainSyncLogRow,
  SyncLogAdapter,
} from '$lib/sync/sync-log-adapter';

export type InMemorySyncLogAdapter = SyncLogAdapter & {
  snapshot(): { plain: PlainSyncLogRow[]; encrypted: EncryptedSyncLogRow[] };
  rejectNextWrite(error: unknown): void;
  emitChange(): void;
  setSignedIn(signedIn: boolean): void;
};

export function createInMemorySyncLogAdapter(): InMemorySyncLogAdapter {
  const plain = new Map<string, PlainSyncLogRow>();
  const encrypted = new Map<string, EncryptedSyncLogRow>();
  const changeListeners = new Set<() => void>();
  const authListeners = new Set<(signedIn: boolean) => void>();
  let nextWriteError: unknown;
  let signedIn = true;

  function takeWriteError(): void {
    if (nextWriteError === undefined) return;
    const error = nextWriteError;
    nextWriteError = undefined;
    throw error;
  }

  return {
    readPlain: async ({ after } = {}) => [...plain.values()]
      .filter((row) => !after || row.insertedAt > after)
      .sort((a, b) => a.insertedAt.localeCompare(b.insertedAt) || a.id.localeCompare(b.id))
      .map((row) => structuredClone(row)),
    readEncrypted: async ({ after, dekVersion } = {}) => [...encrypted.values()]
      .filter((row) => (!after || row.insertedAt > after) && (dekVersion === undefined || row.dekVersion === dekVersion))
      .sort((a, b) => a.insertedAt.localeCompare(b.insertedAt) || a.id.localeCompare(b.id))
      .map((row) => structuredClone(row)),
    async writePlain(rows) {
      takeWriteError();
      for (const row of rows) {
        const current = plain.get(row.id);
        if (!current || row.createdAt >= current.createdAt) plain.set(row.id, structuredClone(row));
      }
    },
    async writeEncrypted(rows) {
      takeWriteError();
      for (const row of rows) {
        const current = encrypted.get(row.id);
        if (!current || row.createdAt >= current.createdAt) encrypted.set(row.id, structuredClone(row));
      }
    },
    async deletePlain(ids) {
      const targets = ids ?? [...plain.keys()];
      let deleted = 0;
      for (const id of targets) if (plain.delete(id)) deleted += 1;
      return deleted;
    },
    async deleteEncrypted(ids) {
      const targets = ids ?? [...encrypted.keys()];
      let deleted = 0;
      for (const id of targets) if (encrypted.delete(id)) deleted += 1;
      return deleted;
    },
    async deleteObservedPlain(rows) {
      let deleted = 0;
      for (const row of rows) {
        const current = plain.get(row.id);
        if (current?.createdAt === row.createdAt && current.insertedAt === row.insertedAt) {
          plain.delete(row.id);
          deleted += 1;
        }
      }
      return deleted;
    },
    async deleteObservedEncrypted(rows) {
      let deleted = 0;
      for (const row of rows) {
        const current = encrypted.get(row.id);
        if (current?.createdAt === row.createdAt && current.insertedAt === row.insertedAt) {
          encrypted.delete(row.id);
          deleted += 1;
        }
      }
      return deleted;
    },
    isWriteModeRejection: (error) => typeof error === 'object' && error !== null
      && (error as { code?: unknown }).code === '42501',
    watch(onChange, onAuthChange) {
      changeListeners.add(onChange);
      authListeners.add(onAuthChange);
      onAuthChange(signedIn);
      return () => {
        changeListeners.delete(onChange);
        authListeners.delete(onAuthChange);
      };
    },
    rejectNextWrite(error) { nextWriteError = error; },
    emitChange() { for (const listener of changeListeners) listener(); },
    setSignedIn(value) {
      signedIn = value;
      for (const listener of authListeners) listener(value);
    },
    snapshot: () => ({
      plain: [...plain.values()].map((row) => structuredClone(row)),
      encrypted: [...encrypted.values()].map((row) => structuredClone(row)),
    }),
  };
}

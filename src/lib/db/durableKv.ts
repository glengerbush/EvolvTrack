import Dexie, { type Table } from 'dexie';

/**
 * A tiny IndexedDB-backed key/value store, deliberately separate from the
 * health-data Dexie database in `schema.ts`.
 *
 * Why IndexedDB and not localStorage: on iOS standalone ("Add to Home Screen")
 * PWAs, WebKit treats localStorage as ephemeral — it is discarded when the app
 * is swiped away — while IndexedDB persists (and we additionally request
 * `navigator.storage.persist()` at boot). The Supabase auth session and the
 * E2EE unlock key used to live in localStorage, so every swipe-away logged the
 * user out even though their data (in IndexedDB) survived. Those two values
 * live here now, so a kill-and-reopen keeps the user signed in and unlocked.
 *
 * It lives in its own database so it survives the health-data db's logout
 * `delete()` / boot-wipe churn untouched; logout clears it explicitly via
 * `durableClear`.
 *
 * Every operation is best-effort: in a context without IndexedDB (private
 * mode, some embedded webviews) the calls resolve to a no-op / null rather
 * than throwing, mirroring the swallow-and-continue posture the old
 * localStorage code used.
 */
interface KvRow {
  key: string;
  value: string;
}

class DurableKvDb extends Dexie {
  kv!: Table<KvRow, string>;

  constructor() {
    super('evolvtrack-auth');
    this.version(1).stores({ kv: 'key' });
  }
}

const kvDb = new DurableKvDb();

export async function durableGet(key: string): Promise<string | null> {
  try {
    const row = await kvDb.kv.get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function durableSet(key: string, value: string): Promise<void> {
  try {
    await kvDb.kv.put({ key, value });
  } catch {
    // IndexedDB unavailable (private mode, quota) — non-fatal.
  }
}

export async function durableRemove(key: string): Promise<void> {
  try {
    await kvDb.kv.delete(key);
  } catch {
    // Non-fatal.
  }
}

export async function durableClear(): Promise<void> {
  try {
    await durableClearOrThrow();
  } catch {
    // Non-fatal.
  }
}

/** Security-sensitive cleanup variant whose failure must remain observable. */
export async function durableClearOrThrow(): Promise<void> {
  await kvDb.kv.clear();
}

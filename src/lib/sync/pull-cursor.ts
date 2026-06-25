/**
 * Incremental-pull cursor: the server-set `inserted_at` of the most recent
 * remote event already applied locally. The next pull asks only for rows
 * inserted after this point.
 *
 * `inserted_at` (cloud time) is used rather than `created_at` (device edit
 * time) because it is monotonic and consistent across devices — a device with
 * a skewed clock can't slip an event past the cursor.
 *
 * Persisted in IndexedDB (via `durableKv`), not localStorage, so it stays
 * consistent with the local data it describes: iOS Home Screen PWAs wipe
 * localStorage on swipe-away but keep IndexedDB, and a cursor that resets while
 * the data survives forces a full re-pull + re-decrypt of the entire history on
 * every reopen. An in-memory mirror keeps the getter synchronous; call
 * `hydratePullCursor` once at boot to load it. `logout` clears the durable
 * store and resets the cursor.
 */
import { durableGet, durableRemove, durableSet } from '$lib/db/durableKv';

const CURSOR_KEY = 'evolvtrack-pull-cursor';

let cursor: string | null = null;

/**
 * Load the persisted cursor into memory at boot. Migrates a value left in the
 * old localStorage slot (desktop / first launch after upgrade) into the durable
 * store. Safe to call before the first sync cycle.
 */
export async function hydratePullCursor(): Promise<void> {
  let stored = await durableGet(CURSOR_KEY);
  if (stored === null && typeof localStorage !== 'undefined') {
    try {
      const legacy = localStorage.getItem(CURSOR_KEY);
      if (legacy !== null) {
        stored = legacy;
        void durableSet(CURSOR_KEY, legacy);
        localStorage.removeItem(CURSOR_KEY);
      }
    } catch {
      // localStorage inaccessible — nothing to migrate.
    }
  }
  cursor = stored;
}

export function getPullCursor(): string | null {
  return cursor;
}

export function setPullCursor(value: string): void {
  cursor = value;
  void durableSet(CURSOR_KEY, value);
}

export function clearPullCursor(): void {
  cursor = null;
  void durableRemove(CURSOR_KEY);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(CURSOR_KEY);
    } catch {
      // Non-fatal; the in-memory + durable clear above is what matters.
    }
  }
}

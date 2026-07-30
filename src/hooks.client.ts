import { browser } from '$app/environment';
import { db } from '$lib/db/schema';
import { WIPE_DB_ON_BOOT_KEY } from '$lib/auth/supabase';

/**
 * Runs once during client init, before any route module loads and before any
 * Svelte component (and therefore any Dexie `liveQuery`) subscribes. If the
 * previous session set the wipe sentinel during logout, drop the IndexedDB
 * here — there are no open connections yet, so `db.delete()` actually
 * completes instead of stalling against module-scoped subscribers.
 */
export async function init(): Promise<void> {
  if (!browser) return;
  let shouldWipe = false;
  try {
    shouldWipe = localStorage.getItem(WIPE_DB_ON_BOOT_KEY) === '1';
  } catch {
    // localStorage is unavailable (private mode, quota exceeded). Nothing we
    // can recover here — proceed with normal boot.
    return;
  }
  if (!shouldWipe) return;
  try {
    await db.delete();
    // Dexie 4's `delete()` closes the connection with auto-open disabled — it
    // does NOT lazily reopen on the next operation the way Dexie 3 did. Reopen
    // the (now empty) database explicitly so the rest of the session can use
    // it; otherwise every subsequent read/write throws "Database has been
    // closed". `open()` re-runs the version definitions, recreating the schema.
    await db.open();
    // Only clear the retry sentinel once both operations succeed. If another
    // tab keeps IndexedDB open or reopening fails, the next boot must retry so
    // signed-out data is not silently left on the device.
    localStorage.removeItem(WIPE_DB_ON_BOOT_KEY);
  } catch (cause) {
    console.error('Failed to wipe local database after logout:', cause);
  }
}

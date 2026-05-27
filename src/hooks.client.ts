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
    if (shouldWipe) localStorage.removeItem(WIPE_DB_ON_BOOT_KEY);
  } catch {
    // localStorage is unavailable (private mode, quota exceeded). Nothing we
    // can recover here — proceed with normal boot.
    return;
  }
  if (!shouldWipe) return;
  try {
    await db.delete();
  } catch (cause) {
    console.error('Failed to wipe local database after logout:', cause);
  }
}

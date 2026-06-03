import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { db } from '$lib/db/schema';

/**
 * Whether the browser can durably store this app's data.
 *
 *  - `unknown`     — not checked yet (SSR, or before `checkStorageHealth` runs).
 *  - `ok`          — IndexedDB works and storage is persistent.
 *  - `ephemeral`   — IndexedDB works *this session*, but the browser hasn't
 *                    granted persistent storage. The common cause we care about
 *                    is a privacy setting like "delete site data when the
 *                    browser closes" (e.g. hardened Firefox forks): the app runs
 *                    fine until you close it, then everything — your data, your
 *                    encryption session, your device identity — is gone.
 *  - `unavailable` — IndexedDB can't be opened at all (some private-mode
 *                    configs). The app can't save anything.
 *
 * Caveat: there is no API that reports "this browser wipes on close." We infer
 * it from `navigator.storage.persisted()` (after asking via `persist()`), which
 * catches the typical clear-on-close configuration (it reports non-persistent)
 * but can't catch a browser that grants persistence yet still wipes on close.
 */
export type StorageHealth = 'unknown' | 'ok' | 'ephemeral' | 'unavailable';

const DISMISS_KEY = 'evolvtrack:storageWarningDismissed';

export const storageHealth = writable<StorageHealth>('unknown');

function loadDismissed(): boolean {
  if (!browser) return false;
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the user has dismissed the storage warning. Persisted so it doesn't
 * nag on every load — which also makes it self-targeting: in a browser that
 * wipes on close, this flag is wiped too, so the warning keeps reappearing for
 * exactly the users whose data really is being lost.
 */
export const storageWarningDismissed = writable<boolean>(loadDismissed());

export function dismissStorageWarning(): void {
  storageWarningDismissed.set(true);
  if (!browser) return;
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Storage unavailable — the dismissal lasts the session, which is fine.
  }
}

/**
 * Which warning (if any) the banner should show. Pure so it's unit-testable.
 * A dismissal hides both tiers; in a wiping browser the dismissal won't survive
 * the next launch, so the warning returns on its own.
 */
export function storageBannerKind(
  health: StorageHealth,
  dismissed: boolean,
): 'unavailable' | 'ephemeral' | null {
  if (dismissed) return null;
  if (health === 'unavailable') return 'unavailable';
  if (health === 'ephemeral') return 'ephemeral';
  return null;
}

async function indexedDbOpens(): Promise<boolean> {
  try {
    // Opening the real Dexie database (idempotent — liveQueries open it anyway)
    // is the truest probe: if IndexedDB is disabled, this rejects.
    await db.open();
    return true;
  } catch {
    return false;
  }
}

async function storageIsPersistent(): Promise<boolean> {
  // No Storage API to consult ⇒ don't cry wolf (older browsers persist fine).
  if (!browser || !navigator.storage?.persisted) return true;
  try {
    if (await navigator.storage.persisted()) return true;
    // Ask for it. Chrome auto-grants for engaged/installed apps; a clear-on-close
    // browser will decline, which is the signal we want.
    if (navigator.storage.persist) return await navigator.storage.persist();
    return false;
  } catch {
    return true;
  }
}

/**
 * Probe storage durability once and publish the result to `storageHealth`.
 * Call from client boot. Best-effort and self-contained — never throws.
 */
export async function checkStorageHealth(): Promise<void> {
  if (!browser) return;
  if (!(await indexedDbOpens())) {
    storageHealth.set('unavailable');
    return;
  }
  storageHealth.set((await storageIsPersistent()) ? 'ok' : 'ephemeral');
}

/**
 * In-memory cache of the user's data encryption key (DEK), mirrored to durable
 * IndexedDB storage so the device stays unlocked until the user logs out.
 *
 * Push/pull need the DEK to encrypt outgoing events and decrypt incoming
 * ones, but unwrapping it from the passphrase on every call would mean
 * re-running PBKDF2, and re-prompting on every reload would be unusable. So
 * this module caches the *DEK bytes* — not the passphrase, not the KEK that
 * unwraps it. The passphrase never touches disk in any form. The DEK is
 * persisted to IndexedDB (via `durableKv`) so a refresh / app reopen unlocks
 * automatically; logout (`clearSession`) is the only thing that wipes it.
 *
 * Why IndexedDB and not localStorage: iOS Home Screen PWAs discard localStorage
 * when the app is swiped away (but keep IndexedDB), so the old localStorage
 * slot meant every reopen re-locked the app. See `durableKv`.
 *
 * The key itself never leaves this module's API; only an "is locked" boolean
 * is published via `sessionLocked` for the UI to observe.
 *
 * Threat model note: EvolvTrack's E2EE guarantee is "the server cannot read
 * your data." It is not "an attacker with your unlocked, logged-in device
 * cannot read your data." Persisting the DEK on the device is intentional —
 * the security boundary is logout, which clears the key and all local data.
 */
import { writable } from 'svelte/store';
import { durableGet, durableRemove, durableSet } from '$lib/db/durableKv';

const STORAGE_KEY = 'et.session.dek';
// Legacy slot from the pre-DEK design where the cached value was the
// passphrase-derived key directly. Wiped alongside the current entry on
// `clearSession` and `setSessionKey` so a stale value can't be picked up by
// `rehydrateSession`.
const LEGACY_STORAGE_KEY = 'et.session.key';

let sessionKey: string | null = null;

/** Reactive `true` when the session has no key cached. */
export const sessionLocked = writable<boolean>(true);

/**
 * Set the derived key for this session and persist it to IndexedDB so
 * subsequent reloads unlock automatically. Persistence is best-effort and
 * fire-and-forget; a quota / private-mode failure still leaves an in-memory
 * unlock for this tab. Any stale localStorage slots from older builds are
 * cleared so they can never re-hydrate after a downgrade/upgrade.
 */
export function setSessionKey(keyB64: string): void {
  sessionKey = keyB64;
  void durableSet(STORAGE_KEY, keyB64);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-fatal; the durable write above is the source of truth.
    }
  }
  sessionLocked.set(false);
}

export function getSessionKey(): string | null {
  return sessionKey;
}

export function hasSessionKey(): boolean {
  return sessionKey !== null;
}

/**
 * Restore a persisted session key (if any) into memory. Resolves to true when
 * a key was found and the session is now unlocked. Async because the durable
 * store is IndexedDB; callers that need the unlock state before their first
 * sync should await it.
 */
export async function rehydrateSession(): Promise<boolean> {
  let stored = await durableGet(STORAGE_KEY);
  if (stored === null) {
    // One-time migration from the old localStorage slot. iOS PWAs will already
    // have lost it on swipe-away; desktop / first-run-after-upgrade carries the
    // unlock across so the user isn't re-prompted for their passphrase.
    if (typeof localStorage !== 'undefined') {
      try {
        const legacy = localStorage.getItem(STORAGE_KEY);
        if (legacy !== null) {
          stored = legacy;
          void durableSet(STORAGE_KEY, legacy);
        }
      } catch {
        // localStorage inaccessible — nothing to migrate.
      }
    }
  }
  if (stored === null) return false;
  sessionKey = stored;
  sessionLocked.set(false);
  return true;
}

/** Wipe both in-memory and persisted state. Called on logout / disable-E2EE. */
export function clearSession(): void {
  sessionKey = null;
  void durableRemove(STORAGE_KEY);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Storage may be inaccessible; in-memory clear is what matters.
    }
  }
  sessionLocked.set(true);
}

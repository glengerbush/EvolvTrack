/**
 * In-memory cache of the user's data encryption key (DEK), mirrored to
 * localStorage so the device stays unlocked until the user logs out.
 *
 * Push/pull need the DEK to encrypt outgoing events and decrypt incoming
 * ones, but unwrapping it from the passphrase on every call would mean
 * re-running PBKDF2, and re-prompting on every reload would be unusable. So
 * this module caches the *DEK bytes* — not the passphrase, not the KEK that
 * unwraps it. The passphrase never touches disk in any form. The DEK is
 * always persisted to localStorage so a refresh / app reopen unlocks
 * automatically; logout (`clearSession`) is the only thing that wipes it.
 *
 * The key itself never leaves this module's API; only an "is locked" boolean
 * is published via `sessionLocked` for the UI to observe.
 *
 * Threat model note: EvolvTrack's E2EE guarantee is "the server cannot read
 * your data." It is not "an attacker with your unlocked, logged-in device
 * cannot read your data." Persisting the DEK in localStorage is intentional —
 * the security boundary is logout, which clears the key and all local data.
 */
import { writable } from 'svelte/store';

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
 * Set the derived key for this session and persist it to localStorage so
 * subsequent reloads unlock automatically. Persistence is best-effort; a
 * quota / private-mode failure still leaves an in-memory unlock for this tab.
 */
export function setSessionKey(keyB64: string): void {
  sessionKey = keyB64;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, keyB64);
    } catch {
      // Quota / private-mode failures are non-fatal; in-memory unlock still works.
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
 * Restore a persisted session key (if any) into memory. Returns true when a
 * key was found and the session is now unlocked. Safe to call before the
 * sync orchestrator starts.
 */
export function rehydrateSession(): boolean {
  if (typeof localStorage === 'undefined') return false;
  let stored: string | null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (!stored) return false;
  sessionKey = stored;
  sessionLocked.set(false);
  return true;
}

/** Wipe both in-memory and persisted state. Called on logout / disable-E2EE. */
export function clearSession(): void {
  sessionKey = null;
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

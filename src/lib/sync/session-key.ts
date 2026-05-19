/**
 * In-memory cache of the user's derived AES key for the current session.
 *
 * Push/pull need this key to encrypt outgoing events and decrypt incoming
 * ones, but PBKDF2-deriving it from the passphrase on every call would be
 * slow, and re-prompting on every reload would be unusable. So this module
 * caches the *derived key bytes* — not the passphrase. The passphrase never
 * touches disk in any form. If the user opts in, the derived key itself is
 * persisted to localStorage so a refresh / app reopen unlocks automatically.
 *
 * The key itself never leaves this module's API; only an "is locked" boolean
 * is published via `sessionLocked` for the UI to observe.
 *
 * Threat model note: EvolvTrack's E2EE guarantee is "the server cannot read
 * your data." It is not "an attacker with your unlocked device cannot read
 * your data." Persisting the derived key in localStorage is intentional.
 */
import { writable } from 'svelte/store';

const STORAGE_KEY = 'et.session.key';

let sessionKey: string | null = null;

/** Reactive `true` when the session has no key cached. */
export const sessionLocked = writable<boolean>(true);

/**
 * Set the derived key for this session. If `persist` is true, the key is also
 * written to localStorage so subsequent reloads unlock automatically.
 */
export function setSessionKey(keyB64: string, options: { persist?: boolean } = {}): void {
  sessionKey = keyB64;
  if (options.persist && typeof localStorage !== 'undefined') {
    try {
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
    } catch {
      // Storage may be inaccessible; in-memory clear is what matters.
    }
  }
  sessionLocked.set(true);
}

/**
 * In-memory passphrase cache for the current session.
 *
 * The encrypted push/pull paths need the user's passphrase to encrypt outgoing
 * events and decrypt incoming ones, but re-prompting on every sync would be
 * unusable. This module holds the passphrase in memory only — it never touches
 * disk or storage — populated when the user unlocks (or runs an E2EE
 * migration) and cleared on logout. If it is empty, encrypted sync simply
 * pauses until the session is unlocked again.
 *
 * The passphrase itself never leaves this module; only an "is locked" boolean
 * is published via `sessionLocked` for the UI to observe.
 */
import { writable } from 'svelte/store';

let sessionPassphrase: string | null = null;

/** Reactive `true` when the session has no passphrase in memory. */
export const sessionLocked = writable<boolean>(true);

export function setSessionPassphrase(passphrase: string): void {
  sessionPassphrase = passphrase;
  sessionLocked.set(false);
}

export function getSessionPassphrase(): string | null {
  return sessionPassphrase;
}

export function clearSessionPassphrase(): void {
  sessionPassphrase = null;
  sessionLocked.set(true);
}

export function hasSessionPassphrase(): boolean {
  return sessionPassphrase !== null;
}

import { writable } from 'svelte/store';

const STORAGE_KEY = 'evolvtrack-setup-wizard-pending';

function readInitial(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

const _pending = writable<boolean>(readInitial());

export const setupWizardPending = {
  subscribe: _pending.subscribe,
  /** Mark a fresh signup so the wizard appears on the next dashboard load. */
  mark() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, 'true');
      } catch {
        // Best-effort.
      }
    }
    _pending.set(true);
  },
  /** Clear the flag whether the wizard finished or was closed early. */
  clear() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Best-effort.
      }
    }
    _pending.set(false);
  },
};

/**
 * Non-reactive read for code paths that can't subscribe (the sync orchestrator
 * runs outside a component context and needs a synchronous answer).
 */
export function isSetupWizardPending(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

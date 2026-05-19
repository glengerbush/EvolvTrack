import { writable } from 'svelte/store';
import { fromLiveQuery } from '$lib/db/liveQuery';
import { db } from '$lib/db/schema';

/**
 * Coarse sync state for the UI.
 *  - `idle`    — nothing in flight (also the "paused" state when locked or
 *                signed out; the E2EE panel surfaces lock state separately)
 *  - `syncing` — a pull/push cycle is running
 *  - `error`   — the last cycle threw; the orchestrator will retry on the
 *                next trigger
 *
 * Connectivity is a separate concern — see `connectivity` below.
 */
export type SyncStatus = 'idle' | 'syncing' | 'error';

export const syncStatus = writable<SyncStatus>('idle');

/**
 * Network connectivity, *honest* about uncertainty:
 *  - `connecting` — initial state, or after an `online` browser event but
 *                   before the next sync cycle has confirmed reachability
 *  - `online`     — last sync cycle reached Supabase successfully
 *  - `offline`    — `navigator.onLine` is false, or the last cycle failed to
 *                   reach the network
 */
export type Connectivity = 'connecting' | 'online' | 'offline';

export const connectivity = writable<Connectivity>('connecting');

/** Last error message from a sync cycle (cleared on success). */
export const lastSyncError = writable<string | null>(null);

/**
 * Whether the current signed-in user has an active license.
 *  - `null`  — unknown (signed out, or not fetched yet)
 *  - `true`  — license is active; cloud sync is allowed
 *  - `false` — no/expired/revoked license; orchestrator skips sync entirely
 */
export const licenseActive = writable<boolean | null>(null);

/** Timestamps of the last successful pull and push, kept separately because
 *  either can be stuck while the other works (e.g. RLS denies inserts but
 *  selects succeed). */
export const lastPullAt = writable<Date | null>(null);
export const lastPushAt = writable<Date | null>(null);

/** Reactive outbox row count. Drives the "N changes waiting" indicator. */
export const outboxCount = fromLiveQuery(() => db.outbox.count(), 0);

const KEY = 'evolvtrack-last-synced';

function getInitial(): Date | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(KEY);
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const _store = writable<Date | null>(getInitial());

export const lastSynced = {
  subscribe: _store.subscribe,
  record() {
    const now = new Date();
    if (typeof window !== 'undefined') localStorage.setItem(KEY, now.toISOString());
    _store.set(now);
  },
};

export function formatSyncTime(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `synced ${time}`;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `synced ${date} ${time}`;
}

/** "5 minutes ago", "just now", "yesterday at 3:14 PM", etc. */
export function formatRelativeTime(d: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24 && d.toDateString() === now.toDateString()) {
    return `${diffHr}h ago`;
  }
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday at ${time}`;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date} at ${time}`;
}

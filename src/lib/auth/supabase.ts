import { createClient } from '@supabase/supabase-js';
import { db } from '$lib/db/schema';
import { durableClear, durableGet, durableRemove, durableSet } from '$lib/db/durableKv';
import { clearSession } from '$lib/sync/session-key';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export const supabaseUrl = url || 'https://example.supabase.co';

const USERNAME_AUTH_DOMAIN = 'users.evolvtrack.com';

function normalizeUsername(username: string) {
  const normalized = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'user';
}

/**
 * The user-facing identifier for an auth account. Username-only sign-ups are
 * stored under a synthetic `@users.evolvtrack.com` address (`toAuthEmail`
 * above); that suffix is server-side plumbing the user never typed, so we
 * strip it on display. Returns null when the user isn't signed in.
 */
export function displayUserIdentifier(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.endsWith(`@${USERNAME_AUTH_DOMAIN}`) ? email.split('@')[0] : email;
}

function toAuthEmail(identifier: string) {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  if (normalizedIdentifier.includes('@')) {
    return normalizedIdentifier;
  }

  return `${normalizeUsername(normalizedIdentifier)}@${USERNAME_AUTH_DOMAIN}`;
}

/**
 * Where Supabase persists the auth session. Backed by IndexedDB (see
 * `durableKv`) instead of the default localStorage because iOS Home Screen
 * PWAs wipe localStorage when the app is swiped away, which logged users out
 * on every reopen. The first read of a key transparently migrates an existing
 * localStorage value, so users who were already signed in under the old
 * localStorage scheme aren't kicked out by the switch.
 *
 * auth-js fully supports an async storage adapter (it awaits these methods).
 */
const indexedDbAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const fromIdb = await durableGet(key);
    if (fromIdb !== null) return fromIdb;
    // One-time migration from the old localStorage slot. On iOS PWAs this is
    // already gone after a swipe-away; on desktop / first run after upgrade it
    // carries the existing session across so nobody has to re-log-in.
    try {
      const legacy = localStorage.getItem(key);
      if (legacy !== null) {
        await durableSet(key, legacy);
        return legacy;
      }
    } catch {
      // localStorage unavailable — nothing to migrate.
    }
    return null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await durableSet(key, value);
  },
  async removeItem(key: string): Promise<void> {
    await durableRemove(key);
  }
};

export const supabase = createClient(url || 'https://example.supabase.co', publishableKey || 'demo-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: indexedDbAuthStorage
  }
});

/**
 * The server's "now" in epoch-ms, read from the `Date` response header of a cheap
 * HEAD against the REST root. Used to anchor LWW timestamps to the server clock
 * (see `$lib/sync/clock`). Returns null on any failure — callers treat it as
 * best-effort and keep their last known offset.
 */
export async function fetchServerTimeMs(): Promise<number | null> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'HEAD',
      headers: { apikey: publishableKey || 'demo-key' },
    });
    const date = res.headers.get('date');
    if (!date) return null;
    const ms = new Date(date).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export async function signInWithPassword(identifier: string, password: string) {
  return supabase.auth.signInWithPassword({ email: toAuthEmail(identifier), password });
}

export async function signInWithMagicLink(email: string) {
  return supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + '/auth/callback' } });
}

/**
 * Sends a password-reset email. Only real email accounts can be reset:
 * username-only accounts are stored under a synthetic @users.evolvtrack.com
 * address that has no inbox, so we refuse those at the boundary instead of
 * silently mailing a domain that cannot deliver.
 */
export async function requestPasswordReset(
  email: string,
): Promise<{ error: { message: string } | null }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@') || normalized.endsWith(`@${USERNAME_AUTH_DOMAIN}`)) {
    return { error: { message: 'Password reset requires a real email address.' } };
  }
  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: window.location.origin + '/auth/reset',
  });
  return { error };
}

export async function signUpWithPassword(identifier: string, password: string) {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const isEmail = normalizedIdentifier.includes('@');
  const authEmail = isEmail ? normalizedIdentifier : toAuthEmail(normalizedIdentifier);
  const username = isEmail ? normalizedIdentifier.split('@')[0] : normalizedIdentifier;

  return supabase.auth.signUp({
    email: authEmail,
    password,
    options: {
      emailRedirectTo: window.location.origin + '/auth/callback',
      data: {
        username: username.trim(),
        signupIdentifier: normalizedIdentifier,
        usedGeneratedEmail: !isEmail
      }
    }
  });
}

/**
 * Permanently deletes the signed-in user's account on the server (auth.users
 * + every FK-cascaded row) and then wipes local state, identical to a
 * logout. Throws if the RPC fails so the caller can surface the error before
 * any local cleanup runs.
 */
export async function deleteAccountAndClearLocalData() {
  const { error } = await supabase.rpc('delete_self');
  if (error) throw new Error(error.message);
  await logoutAndClearLocalData();
}

export async function logoutAndClearLocalData() {
  // Tell the server to end *this device's* session. `scope: 'local'` (the
  // supabase default) leaves the user's sessions on other devices alone —
  // logging out on a laptop should not boot the user's phone PWA. Best-effort:
  // network failures, expired tokens, or server outages must NOT abort local
  // cleanup, otherwise the persisted session key and other auth state stay on
  // disk after the user clicked "Log out". The local credentials are gone
  // regardless of whether the server got the memo.
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Best-effort server signout.
  }

  clearSession();

  // Wipe the IndexedDB-backed auth store (Supabase session token + E2EE DEK).
  // It lives in its own database, so the health-data `db.delete()` below does
  // not touch it — clear it explicitly or a logged-out device would reopen
  // still holding a usable session.
  await durableClear();

  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Best-effort local cleanup.
  }

  // Wipe IndexedDB. The local domain tables are plaintext at rest, so they
  // must be gone before the user can inspect them after logging out. Set the
  // boot-guard sentinel FIRST so that if the inline wipe below is interrupted
  // (tab closed mid-logout, or a second PWA tab holds the connection open and
  // blocks the delete), `hooks.client.ts` still finishes the job on next boot.
  try {
    localStorage.setItem(WIPE_DB_ON_BOOT_KEY, '1');
  } catch {
    // Best-effort: if this fails the inline wipe below is the only line of
    // defense; stale rows may linger if it's also interrupted.
  }

  // Force-close the connection first. Module-scoped `liveQuery` subscribers
  // (outboxCount, profileStore, rawPrescriptions, medicationRows) otherwise
  // hold the database open and Dexie's blocked-delete timeout silently wins,
  // leaving the data on disk. `close()` drops those connections so the delete
  // actually completes here, before we navigate away.
  try {
    db.close();
    await db.delete();
    // Wiped successfully — the boot guard no longer needs to run.
    try {
      localStorage.removeItem(WIPE_DB_ON_BOOT_KEY);
    } catch {
      // Non-fatal: a redundant boot wipe is harmless.
    }
  } catch {
    // Delete was blocked or threw (e.g. another tab holds the DB open). Leave
    // the sentinel set so the boot guard retries on next launch.
  }

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {
      // Best-effort cache cleanup.
    }
  }

  // Callers (AppShell/Dashboard handleLogout) follow this with
  // `window.location.href = '/auth'`, which is the full reload that lets the
  // boot guard wipe IndexedDB before any liveQuery subscribes again.
}

/** localStorage flag consumed by the client boot guard to wipe IndexedDB. */
export const WIPE_DB_ON_BOOT_KEY = 'evolvtrack-wipe-db-on-boot';

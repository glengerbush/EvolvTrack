import { createClient } from '@supabase/supabase-js';
import { db } from '$lib/db/schema';
import { clearSession } from '$lib/sync/session-key';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

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

function toAuthEmail(identifier: string) {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  if (normalizedIdentifier.includes('@')) {
    return normalizedIdentifier;
  }

  return `${normalizeUsername(normalizedIdentifier)}@${USERNAME_AUTH_DOMAIN}`;
}

export const supabase = createClient(url || 'https://example.supabase.co', anonKey || 'demo-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

export async function signInWithPassword(identifier: string, password: string) {
  return supabase.auth.signInWithPassword({ email: toAuthEmail(identifier), password });
}

export async function signInWithMagicLink(email: string) {
  return supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + '/auth/callback' } });
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
  // Tell the server to invalidate all sessions for this user. Best-effort:
  // network failures, expired tokens, or server outages must NOT abort local
  // cleanup, otherwise the persisted session key and other auth state stay on
  // disk after the user clicked "Log out". The local credentials are gone
  // regardless of whether the server got the memo.
  try {
    await supabase.auth.signOut({ scope: 'global' });
  } catch {
    // Best-effort server signout.
  }

  clearSession();

  const dbDeleteTimeoutMs = 1500;
  await Promise.race([
    db.delete(),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, dbDeleteTimeoutMs);
    })
  ]).catch(() => undefined);

  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Best-effort local cleanup.
  }

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {
      // Best-effort cache cleanup.
    }
  }
}

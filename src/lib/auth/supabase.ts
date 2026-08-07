import { createClient } from '@supabase/supabase-js';
import { resolve } from '$app/paths';
import {
  durableClearOrThrow,
  durableGet,
  durableRemove,
  durableSet,
} from '$lib/db/durableKv';
import {
  cancelPreparedAccountDeletionErasure,
  confirmAccountDeletionErasure,
  getPendingDeviceDataErasure,
  prepareAccountDeletionErasure,
} from '$lib/security/device-data-erasure';

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
 * Revoke this runtime's usable Supabase session without depending on the
 * network. Stopping refresh and draining auth-js's lock prevents an in-flight
 * refresh from restoring credentials after the durable auth store is cleared.
 */
export async function revokeLocalAuthSessionForDeviceDataErasure(): Promise<void> {
  await supabase.auth.stopAutoRefresh?.();
  await supabase.auth.getSession();
  await durableClearOrThrow();
}

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
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: new URL(resolve('/auth/callback'), window.location.origin).href },
  });
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
    redirectTo: new URL(resolve('/auth/reset'), window.location.origin).href,
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
      emailRedirectTo: new URL(resolve('/auth/callback'), window.location.origin).href,
      data: {
        username: username.trim(),
        signupIdentifier: normalizedIdentifier,
        usedGeneratedEmail: !isEmail
      }
    }
  });
}

/**
 * Reauthenticates with the existing password before updating it. Requiring the
 * current credential protects an unlocked or unattended device from silently
 * taking over the account.
 */
export async function changeLoginPassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ error: { message: string } | null }> {
  const { data, error: userError } = await supabase.auth.getUser();
  const email = data.user?.email;
  if (userError || !email) {
    return { error: { message: 'You must be signed in.' } };
  }

  const { error: passwordError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (passwordError) {
    return { error: { message: 'Current password did not match.' } };
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  return { error };
}

/**
 * Permanently deletes the signed-in user's account on the server (auth.users
 * + every FK-cascaded row) and then performs Device Data Erasure, identical to
 * logout. Throws if the RPC fails so the caller can surface the error before
 * local erasure begins.
 */
async function accountDeletionWasConfirmed(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('account_deletion_confirmed', {
    p_request_id: id,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

async function requestAccountDeletion(id: string, recovering: boolean): Promise<void> {
  const { error } = await supabase.rpc('delete_self', { p_request_id: id });
  if (!error || (await accountDeletionWasConfirmed(id))) {
    await confirmAccountDeletionErasure(id);
    return;
  }

  if (!recovering) await cancelPreparedAccountDeletionErasure(id);
  throw new Error(error.message);
}

export async function deleteAccountAndEraseDeviceData(): Promise<void> {
  const id = await prepareAccountDeletionErasure();
  await requestAccountDeletion(id, false);
}

/** Retry/verify a crash-interrupted account deletion before local erasure. */
export async function resumePreparedAccountDeletion(): Promise<void> {
  const marker = await getPendingDeviceDataErasure();
  if (!marker || marker.phase !== 'account-deletion-prepared') return;

  if (await accountDeletionWasConfirmed(marker.operationId)) {
    await confirmAccountDeletionErasure(marker.operationId);
    return;
  }
  await requestAccountDeletion(marker.operationId, true);
}

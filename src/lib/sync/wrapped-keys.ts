/**
 * Read/write the user's wrapped DEK bundle(s) in both stores:
 *   - locally (`db.wrappedKeys`, single row keyed `'self'`) — caches the
 *     *active* bundle for offline same-device unlock.
 *   - remotely (`public.wrapped_keys`, keyed by `(user_id, dek_version)`) —
 *     enables new-device recovery, and holds BOTH the old and new bundle for
 *     the duration of a key rotation. Server stores only ciphertext.
 *
 * The remote store is version-aware (a rotation keeps two bundles); the local
 * cache only ever holds the active one. The enable / rotate / disable / restore
 * flows in `e2ee-migration.ts` keep them in sync; this module is a thin data
 * layer.
 */
import { db } from '$lib/db/schema';
import { supabase } from '$lib/auth/supabase';
import { requireAuthenticatedUser } from '$lib/sync/account-state';
import { LEGACY_PBKDF2_ITERATIONS } from '$lib/crypto/e2ee';
import type { WrappedKeyBundle } from '$lib/domain/types';

const BUNDLE_KEY = 'self' as const;

type WrappedKeyRow = {
  dek_version: number;
  passphrase_salt_b64: string;
  passphrase_wrapped_ciphertext: string;
  passphrase_wrapped_iv: string;
  passphrase_iterations: number | null;
  recovery_salt_b64: string;
  recovery_wrapped_ciphertext: string;
  recovery_wrapped_iv: string;
  recovery_iterations: number | null;
  updated_at: string;
};

function rowToBundle(row: WrappedKeyRow): WrappedKeyBundle {
  return {
    id: BUNDLE_KEY,
    dekVersion: row.dek_version,
    passphraseSaltB64: row.passphrase_salt_b64,
    passphraseWrapped: {
      ciphertext: row.passphrase_wrapped_ciphertext,
      iv: row.passphrase_wrapped_iv,
    },
    passphraseIterations: row.passphrase_iterations ?? LEGACY_PBKDF2_ITERATIONS,
    recoverySaltB64: row.recovery_salt_b64,
    recoveryWrapped: {
      ciphertext: row.recovery_wrapped_ciphertext,
      iv: row.recovery_wrapped_iv,
    },
    recoveryIterations: row.recovery_iterations ?? LEGACY_PBKDF2_ITERATIONS,
    updatedAt: row.updated_at,
  };
}

/** Backfill iteration counts on a bundle read from a store that predates the
 *  `*_iterations` fields, so legacy local rows still unwrap. */
function withIterationDefaults(bundle: WrappedKeyBundle): WrappedKeyBundle {
  return {
    ...bundle,
    passphraseIterations: bundle.passphraseIterations ?? LEGACY_PBKDF2_ITERATIONS,
    recoveryIterations: bundle.recoveryIterations ?? LEGACY_PBKDF2_ITERATIONS,
  };
}

export async function getLocalWrappedKeys(): Promise<WrappedKeyBundle | undefined> {
  const bundle = await db.wrappedKeys.get(BUNDLE_KEY);
  return bundle ? withIterationDefaults(bundle) : undefined;
}

export async function saveLocalWrappedKeys(
  bundle: Omit<WrappedKeyBundle, 'id'>,
): Promise<WrappedKeyBundle> {
  const row: WrappedKeyBundle = { id: BUNDLE_KEY, ...bundle };
  await db.wrappedKeys.put(row);
  return row;
}

export async function clearLocalWrappedKeys(): Promise<void> {
  await db.wrappedKeys.delete(BUNDLE_KEY);
}

/**
 * Fetch one wrapped-key bundle from the server. With `dekVersion` it fetches
 * exactly that version (used by rotation / dual-passphrase recovery, where two
 * versions coexist). Without it, returns the newest bundle — which in steady
 * state is the only one, i.e. the active bundle.
 */
export async function fetchRemoteWrappedKeys(dekVersion?: number): Promise<WrappedKeyBundle | null> {
  const user = await requireAuthenticatedUser();
  let query = supabase.from('wrapped_keys').select('*').eq('user_id', user.id);
  if (dekVersion !== undefined) {
    query = query.eq('dek_version', dekVersion);
  } else {
    // Newest bundle = active in steady state; during a rotation this is the
    // pending one, so rotation/recovery callers pass an explicit version.
    query = query.order('dek_version', { ascending: false }).limit(1);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ? rowToBundle(data as WrappedKeyRow) : null;
}

/** Fetch every wrapped-key bundle for the user (0, 1, or — mid-rotation — 2). */
export async function fetchAllRemoteWrappedKeys(): Promise<WrappedKeyBundle[]> {
  const user = await requireAuthenticatedUser();
  const { data, error } = await supabase
    .from('wrapped_keys')
    .select('*')
    .eq('user_id', user.id)
    .order('dek_version', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => rowToBundle(row as WrappedKeyRow));
}

export async function upsertRemoteWrappedKeys(bundle: WrappedKeyBundle): Promise<void> {
  const user = await requireAuthenticatedUser();
  // Keyed by (user_id, dek_version): upserting a new version inserts a second
  // row rather than clobbering the existing bundle — that's what lets both the
  // old and new key survive together during a rotation.
  const { error } = await supabase.from('wrapped_keys').upsert(
    {
      user_id: user.id,
      dek_version: bundle.dekVersion,
      passphrase_salt_b64: bundle.passphraseSaltB64,
      passphrase_wrapped_ciphertext: bundle.passphraseWrapped.ciphertext,
      passphrase_wrapped_iv: bundle.passphraseWrapped.iv,
      passphrase_iterations: bundle.passphraseIterations,
      recovery_salt_b64: bundle.recoverySaltB64,
      recovery_wrapped_ciphertext: bundle.recoveryWrapped.ciphertext,
      recovery_wrapped_iv: bundle.recoveryWrapped.iv,
      recovery_iterations: bundle.recoveryIterations,
      updated_at: bundle.updatedAt,
    },
    { onConflict: 'user_id,dek_version' },
  );
  if (error) throw error;
}

/**
 * Delete wrapped-key bundles. With `dekVersion`, deletes only that version
 * (used to drop the old bundle once a rotation finishes). Without it, deletes
 * every bundle for the user (disable / reset / start-fresh).
 */
export async function deleteRemoteWrappedKeys(dekVersion?: number): Promise<void> {
  const user = await requireAuthenticatedUser();
  let query = supabase.from('wrapped_keys').delete().eq('user_id', user.id);
  if (dekVersion !== undefined) query = query.eq('dek_version', dekVersion);
  const { error } = await query;
  if (error) throw error;
}

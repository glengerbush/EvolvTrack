/**
 * Read/write the user's wrapped DEK bundle in both stores:
 *   - locally (`db.wrappedKeys`, single row keyed `'self'`) — enables offline
 *     same-device recovery when the cached session key was cleared but the
 *     wrapped DEK is still on disk.
 *   - remotely (`public.wrapped_keys`, single row per user) — enables
 *     new-device recovery. Server stores only ciphertext.
 *
 * The two copies should track each other 1:1. The enable / rotate / disable
 * flows in `e2ee-migration.ts` are responsible for keeping them in sync; this
 * module is a thin data layer.
 */
import { db } from '$lib/db/schema';
import { supabase } from '$lib/auth/supabase';
import { requireAuthenticatedUser } from '$lib/sync/account-state';
import type { WrappedKeyBundle } from '$lib/domain/types';

const BUNDLE_KEY = 'self' as const;

export async function getLocalWrappedKeys(): Promise<WrappedKeyBundle | undefined> {
  return db.wrappedKeys.get(BUNDLE_KEY);
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

export async function fetchRemoteWrappedKeys(): Promise<WrappedKeyBundle | null> {
  const user = await requireAuthenticatedUser();
  const { data, error } = await supabase
    .from('wrapped_keys')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: BUNDLE_KEY,
    dekVersion: data.dek_version,
    passphraseSaltB64: data.passphrase_salt_b64,
    passphraseWrapped: {
      ciphertext: data.passphrase_wrapped_ciphertext,
      iv: data.passphrase_wrapped_iv,
    },
    recoverySaltB64: data.recovery_salt_b64,
    recoveryWrapped: {
      ciphertext: data.recovery_wrapped_ciphertext,
      iv: data.recovery_wrapped_iv,
    },
    updatedAt: data.updated_at,
  };
}

export async function upsertRemoteWrappedKeys(bundle: WrappedKeyBundle): Promise<void> {
  const user = await requireAuthenticatedUser();
  const { error } = await supabase.from('wrapped_keys').upsert(
    {
      user_id: user.id,
      dek_version: bundle.dekVersion,
      passphrase_salt_b64: bundle.passphraseSaltB64,
      passphrase_wrapped_ciphertext: bundle.passphraseWrapped.ciphertext,
      passphrase_wrapped_iv: bundle.passphraseWrapped.iv,
      recovery_salt_b64: bundle.recoverySaltB64,
      recovery_wrapped_ciphertext: bundle.recoveryWrapped.ciphertext,
      recovery_wrapped_iv: bundle.recoveryWrapped.iv,
      updated_at: bundle.updatedAt,
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

export async function deleteRemoteWrappedKeys(): Promise<void> {
  const user = await requireAuthenticatedUser();
  const { error } = await supabase.from('wrapped_keys').delete().eq('user_id', user.id);
  if (error) throw error;
}

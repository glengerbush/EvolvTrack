import { nanoid } from 'nanoid';
import { supabase } from '$lib/auth/supabase';
import type { E2EEMigrationState, SyncMode } from '$lib/domain/types';

const DEVICE_ID_KEY = 'evolvtrack-device-id';

function nowIso() {
  return new Date().toISOString();
}

export function getDeviceId(): string {
  if (typeof localStorage === 'undefined') return 'server';

  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;

  const id = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : nanoid();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

export async function requireAuthenticatedUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('Sign in before syncing data.');
  return data.user;
}

/**
 * Soft auth check for the sync orchestrator: returns the user id, or null when
 * signed out. Unlike `requireAuthenticatedUser` it never throws, so background
 * sync can simply skip a cycle instead of surfacing an error.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

export async function upsertRemoteSyncAccount(
  syncMode: SyncMode,
  migration?: E2EEMigrationState,
): Promise<void> {
  const user = await requireAuthenticatedUser();
  const timestamp = nowIso();

  const { error } = await supabase.from('sync_accounts').upsert({
    user_id: user.id,
    sync_mode: syncMode,
    e2ee_migration_id: migration?.id ?? null,
    e2ee_migration_direction: migration?.direction ?? null,
    migration_owner_device_id: migration?.ownerDeviceId ?? null,
    migration_started_at: migration?.startedAt ?? null,
    migration_updated_at: migration?.updatedAt ?? null,
    migration_completed_at: migration?.completedAt ?? null,
    plaintext_high_water_mark: migration?.plaintextHighWaterMark ?? null,
    updated_at: timestamp,
  }, { onConflict: 'user_id' });

  if (error) throw error;
}

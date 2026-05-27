import { nanoid } from 'nanoid';
import { supabase } from '$lib/auth/supabase';
import type { E2EEMigrationState, SyncMode } from '$lib/domain/types';

const SYNC_MODES: ReadonlySet<SyncMode> = new Set<SyncMode>([
  'plain',
  'migrating_to_e2ee',
  'e2ee',
  'migrating_to_plain',
  'rotating_e2ee_key',
]);

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

/**
 * Read the server's canonical sync mode for the current user. Returns null
 * when the account has no `sync_accounts` row yet (brand-new user that has
 * never enabled E2EE — the orchestrator treats this the same as a default
 * plain account). Throws on transport/auth errors so the caller can decide
 * whether to bail out of the cycle.
 */
export async function fetchRemoteSyncMode(): Promise<SyncMode | null> {
  const user = await requireAuthenticatedUser();
  const { data, error } = await supabase
    .from('sync_accounts')
    .select('sync_mode')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const mode = data.sync_mode as string;
  return SYNC_MODES.has(mode as SyncMode) ? (mode as SyncMode) : null;
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

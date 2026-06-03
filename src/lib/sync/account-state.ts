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
  const account = await fetchRemoteSyncAccount();
  return account?.syncMode ?? null;
}

export type RemoteSyncAccount = {
  syncMode: SyncMode;
  /** Present only while a migration is in flight (any `migrating_*` /
   * `rotating_*` mode). Reconstructed from the `sync_accounts` columns so a
   * device that logs in mid-migration learns one is underway and who owns it. */
  migration?: E2EEMigrationState;
  /** The DEK version steady-state sync reads/writes (null ⇒ pre-versioning,
   * treat as 1). */
  activeDekVersion?: number;
  /** The DEK version a key rotation is migrating toward; undefined when no
   * rotation is in progress. */
  pendingDekVersion?: number;
};

/**
 * Read the server's canonical sync state for the current user — the mode plus
 * the in-flight migration record, if any. Returns null when there's no
 * `sync_accounts` row yet. Throws on transport/auth errors.
 */
export async function fetchRemoteSyncAccount(): Promise<RemoteSyncAccount | null> {
  const user = await requireAuthenticatedUser();
  const { data, error } = await supabase
    .from('sync_accounts')
    .select(
      'sync_mode, e2ee_migration_id, e2ee_migration_direction, migration_owner_device_id, migration_started_at, migration_updated_at, migration_completed_at, plaintext_high_water_mark, migration_records_total, migration_records_converted, active_dek_version, pending_dek_version',
    )
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const mode = data.sync_mode as string;
  if (!SYNC_MODES.has(mode as SyncMode)) return null;

  const startedAt = (data.migration_started_at as string | null) ?? undefined;
  const updatedAt = (data.migration_updated_at as string | null) ?? undefined;
  const migration: E2EEMigrationState | undefined = data.e2ee_migration_id
    ? {
        id: data.e2ee_migration_id as string,
        direction: (data.e2ee_migration_direction as E2EEMigrationState['direction']) ?? undefined,
        ownerDeviceId: (data.migration_owner_device_id as string | null) ?? '',
        startedAt: startedAt ?? updatedAt ?? nowIso(),
        updatedAt: updatedAt ?? startedAt ?? nowIso(),
        completedAt: (data.migration_completed_at as string | null) ?? undefined,
        plaintextHighWaterMark: (data.plaintext_high_water_mark as string | null) ?? undefined,
        recordsTotal: (data.migration_records_total as number | null) ?? undefined,
        recordsConverted: (data.migration_records_converted as number | null) ?? undefined,
      }
    : undefined;

  return {
    syncMode: mode as SyncMode,
    migration,
    activeDekVersion: (data.active_dek_version as number | null) ?? undefined,
    pendingDekVersion: (data.pending_dek_version as number | null) ?? undefined,
  };
}

/**
 * DEK-version columns to write alongside the sync mode. Each field is only
 * included in the upsert when explicitly provided, so callers that don't manage
 * versioning leave the existing column values untouched (an omitted column is
 * not in the conflict UPDATE set). Pass `null` to clear a column.
 */
export type DekVersionUpdate = {
  activeDekVersion?: number | null;
  pendingDekVersion?: number | null;
};

export async function upsertRemoteSyncAccount(
  syncMode: SyncMode,
  migration?: E2EEMigrationState,
  dekVersions?: DekVersionUpdate,
): Promise<void> {
  const user = await requireAuthenticatedUser();
  const timestamp = nowIso();

  const payload: Record<string, unknown> = {
    user_id: user.id,
    sync_mode: syncMode,
    e2ee_migration_id: migration?.id ?? null,
    e2ee_migration_direction: migration?.direction ?? null,
    migration_owner_device_id: migration?.ownerDeviceId ?? null,
    migration_started_at: migration?.startedAt ?? null,
    migration_updated_at: migration?.updatedAt ?? null,
    migration_completed_at: migration?.completedAt ?? null,
    plaintext_high_water_mark: migration?.plaintextHighWaterMark ?? null,
    migration_records_total: migration?.recordsTotal ?? null,
    migration_records_converted: migration?.recordsConverted ?? null,
    updated_at: timestamp,
  };
  if (dekVersions && 'activeDekVersion' in dekVersions) {
    payload.active_dek_version = dekVersions.activeDekVersion;
  }
  if (dekVersions && 'pendingDekVersion' in dekVersions) {
    payload.pending_dek_version = dekVersions.pendingDekVersion;
  }

  const { error } = await supabase.from('sync_accounts').upsert(payload, { onConflict: 'user_id' });

  if (error) throw error;
}

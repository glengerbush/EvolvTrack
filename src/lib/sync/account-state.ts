import { nanoid } from 'nanoid';
import { supabase } from '$lib/auth/supabase';
import { durableGet, durableSet } from '$lib/db/durableKv';
import type { E2EEMigrationState, E2EETransitionPhase, SyncMode } from '$lib/domain/types';

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

/**
 * The device's stable identity, used as the migration-ownership token in
 * `sync_accounts` (`migration_owner_device_id`) and the take-over CAS. It MUST
 * survive an app quit: a regenerated id is a *different* device, so an iOS PWA
 * swiped away mid-migration would no longer recognize itself as the owner and
 * couldn't heartbeat or finalize its own migration. So it lives in durable
 * IndexedDB (via `durableKv`), not localStorage (wiped on iOS swipe-away).
 *
 * An in-memory mirror keeps `getDeviceId` synchronous for the migration code;
 * `hydrateDeviceId` loads it at boot, before any migration action can run.
 */
let deviceId: string | null = null;

function mintDeviceId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : nanoid();
}

/**
 * Load the stable device id into memory at boot: durable store first, then a
 * one-time migration of a legacy localStorage value, then mint-and-persist as a
 * last resort. A persisted id always wins over one `getDeviceId` may have minted
 * before this ran, so device identity stays continuous. Idempotent.
 */
export async function hydrateDeviceId(): Promise<string> {
  let stored = await durableGet(DEVICE_ID_KEY);
  if (stored === null && typeof localStorage !== 'undefined') {
    try {
      const legacy = localStorage.getItem(DEVICE_ID_KEY);
      if (legacy !== null) {
        stored = legacy;
        localStorage.removeItem(DEVICE_ID_KEY);
      }
    } catch {
      // localStorage inaccessible — nothing to migrate.
    }
  }
  if (stored === null) stored = deviceId ?? mintDeviceId();
  deviceId = stored;
  void durableSet(DEVICE_ID_KEY, stored);
  return stored;
}

export function getDeviceId(): string {
  if (deviceId) return deviceId;
  // SSR / no browser storage: a synthetic id, never persisted.
  if (typeof localStorage === 'undefined' && typeof indexedDB === 'undefined') return 'server';
  // Hydrate hasn't completed and an id is needed now (rare — migration actions
  // run well after boot, by which point hydrateDeviceId has populated the cache).
  // Mint into memory only — deliberately NOT persisted, so this temporary value
  // can't clobber an id already sitting in the durable store before
  // hydrateDeviceId reads it. hydrate persists whatever it settles on.
  deviceId = mintDeviceId();
  return deviceId;
}

/** Test seam: drop the in-memory device id so each test starts clean. */
export function __resetDeviceIdForTests(): void {
  deviceId = null;
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
      'sync_mode, e2ee_migration_id, e2ee_migration_direction, e2ee_transition_phase, migration_owner_device_id, migration_started_at, migration_updated_at, migration_completed_at, plaintext_high_water_mark, migration_records_total, migration_records_converted, active_dek_version, pending_dek_version',
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
        phase: (data.e2ee_transition_phase as E2EETransitionPhase | null) ?? undefined,
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

/** Raised when another device has already moved the account out of the mode this
 * transition required to start (the cross-device mutual-exclusion signal). */
export class SyncTransitionConflictError extends Error {
  constructor() {
    super('Another device is already changing encryption settings. Wait for it to finish, or use “Take over”.');
    this.name = 'SyncTransitionConflictError';
  }
}

/** Raised when a migration this device was driving has been claimed (taken over)
 * by another device. The signal to stop WITHOUT writing any failure/clobbering
 * state — the new owner is finishing it, and the next reconcile converges. */
export class MigrationSupersededError extends Error {
  constructor() {
    super('This migration was taken over by another device.');
    this.name = 'MigrationSupersededError';
  }
}

/**
 * Atomically claim an E2EE sync-mode transition on the server (see the
 * `begin_sync_transition` RPC). This is the authoritative cross-device guard:
 * only one device can move the account into a migrating/rotating state at a
 * time, and the next DEK version is allocated here so concurrent rotations can't
 * collide. Throws `SyncTransitionConflictError` if another device got there
 * first; the caller must abort its operation.
 */
export async function beginSyncTransition(params: {
  from: SyncMode[];
  to: SyncMode;
  migration: E2EEMigrationState;
  allocateNewDek: boolean;
}): Promise<{ activeDekVersion: number | null; pendingDekVersion: number | null }> {
  await requireAuthenticatedUser();
  const { data, error } = await supabase.rpc('begin_sync_transition', {
    p_from: params.from,
    p_to: params.to,
    p_migration_id: params.migration.id,
    p_direction: params.migration.direction ?? null,
    p_owner_device_id: params.migration.ownerDeviceId,
    p_allocate_new_dek: params.allocateNewDek,
  });
  if (error) {
    if (/sync_transition_conflict/.test(error.message ?? '')) {
      throw new SyncTransitionConflictError();
    }
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { active_version: number | null; pending_version: number | null }
    | undefined;
  return {
    activeDekVersion: row?.active_version ?? null,
    pendingDekVersion: row?.pending_version ?? null,
  };
}

/**
 * Atomically claim ownership of an in-flight migration (the "Take over on this
 * device" affordance). A compare-and-swap on the owner this device last
 * observed (`expectedOwnerDeviceId`): see the `claim_migration_owner` RPC. Only
 * one of several waiting devices can win — the rest get
 * `SyncTransitionConflictError` and must re-render from the refreshed state.
 */
export async function claimMigrationOwner(params: {
  migrationId: string;
  expectedOwnerDeviceId: string;
  newOwnerDeviceId: string;
}): Promise<void> {
  await requireAuthenticatedUser();
  const { error } = await supabase.rpc('claim_migration_owner', {
    p_migration_id: params.migrationId,
    p_expected_owner_device_id: params.expectedOwnerDeviceId,
    p_new_owner_device_id: params.newOwnerDeviceId,
  });
  if (error) {
    if (/sync_transition_conflict/.test(error.message ?? '')) {
      throw new SyncTransitionConflictError();
    }
    throw error;
  }
}

export async function advanceSyncTransitionPhase(params: {
  migrationId: string;
  ownerDeviceId: string;
  phase: E2EETransitionPhase;
}): Promise<void> {
  await requireAuthenticatedUser();
  const { error } = await supabase.rpc('advance_sync_transition_phase', {
    p_migration_id: params.migrationId,
    p_owner_device_id: params.ownerDeviceId,
    p_phase: params.phase,
  });
  if (error) {
    if (/sync_transition_conflict/.test(error.message ?? '')) {
      throw new MigrationSupersededError();
    }
    throw error;
  }
}

export async function abandonSyncTransition(params: {
  migrationId: string;
  ownerDeviceId: string;
}): Promise<void> {
  await requireAuthenticatedUser();
  const { error } = await supabase.rpc('abandon_sync_transition', {
    p_migration_id: params.migrationId,
    p_owner_device_id: params.ownerDeviceId,
  });
  if (error) {
    if (/sync_transition_conflict/.test(error.message ?? '')) {
      throw new MigrationSupersededError();
    }
    throw error;
  }
}

export async function startFreshSync(params: {
  migrationId: string;
  ownerDeviceId: string;
}): Promise<void> {
  await requireAuthenticatedUser();
  const { error } = await supabase.rpc('start_fresh_sync', {
    p_migration_id: params.migrationId,
    p_owner_device_id: params.ownerDeviceId,
  });
  if (error) {
    if (/sync_transition_conflict/.test(error.message ?? '')) {
      throw new MigrationSupersededError();
    }
    throw error;
  }
}

/**
 * Finalize a migration into its steady-state mode, but only if this device
 * still owns it (see the `complete_sync_transition` RPC). If another device
 * took the migration over, this raises `MigrationSupersededError` and writes
 * nothing — so a slow original owner can't clobber the new owner's state.
 * `activeDekVersion` is written verbatim (null when disabling); the pending
 * version is always cleared.
 */
export async function completeSyncTransition(params: {
  migrationId: string;
  ownerDeviceId: string;
  to: SyncMode;
  activeDekVersion: number | null;
}): Promise<void> {
  await requireAuthenticatedUser();
  const { error } = await supabase.rpc('complete_sync_transition', {
    p_migration_id: params.migrationId,
    p_owner_device_id: params.ownerDeviceId,
    p_to: params.to,
    p_active_version: params.activeDekVersion,
  });
  if (error) {
    if (/sync_transition_conflict/.test(error.message ?? '')) {
      throw new MigrationSupersededError();
    }
    throw error;
  }
}

/**
 * Stamp a progress + liveness heartbeat for a migration this device owns.
 *
 * Unlike `upsertRemoteSyncAccount`, this NEVER writes `sync_mode` (or ownership)
 * and is scoped `WHERE migration_owner_device_id = <owner>`: if the device has
 * been superseded the update touches zero rows instead of resurrecting a stale
 * mode/owner over the new owner's claim. Used for the mid-backfill heartbeats.
 */
export async function heartbeatMigrationProgress(migration: E2EEMigrationState): Promise<void> {
  const user = await requireAuthenticatedUser();
  const { error } = await supabase
    .from('sync_accounts')
    .update({
      migration_updated_at: migration.updatedAt,
      migration_records_total: migration.recordsTotal ?? null,
      migration_records_converted: migration.recordsConverted ?? null,
      updated_at: nowIso(),
    })
    .eq('user_id', user.id)
    .eq('e2ee_migration_id', migration.id)
    .eq('migration_owner_device_id', migration.ownerDeviceId);
  if (error) throw error;
}

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
    e2ee_transition_phase: migration?.phase ?? null,
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

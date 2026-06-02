import { derived, type Readable } from 'svelte/store';
import {
  connectivity,
  lastPullAt,
  lastPushAt,
  lastSyncError,
  lastSynced,
  licenseActive,
  outboxCount,
  syncStatus,
  type Connectivity,
  type SyncStatus,
} from './syncStore';
import { authState, type AuthState } from './authStore';
import { sessionLocked } from '$lib/sync/session-key';
import { fromLiveQuery } from '$lib/db/liveQuery';
import { db } from '$lib/db/schema';
import { getProfileSyncMode } from '$lib/domain/repo';
import type { ProfileSettings, SyncMode } from '$lib/domain/types';

const profileStore: Readable<ProfileSettings | undefined> = fromLiveQuery(
  () => db.profile.get('profile'),
  undefined,
);

/**
 * The headline state shown on the sync pill. Ordered by user-facing priority:
 * `signed-out-expired` outranks everything else because the user needs to
 * re-auth before anything else can recover, etc.
 */
export type SyncKind =
  | 'signed-out'
  | 'signed-out-expired'
  | 'auth-loading'
  | 'connecting'
  | 'offline'
  | 'no-license'
  | 'locked'
  | 'migration-paused'
  | 'migrating'
  | 'syncing'
  | 'pending'
  | 'error'
  | 'synced';

export type SyncIndicator = {
  kind: SyncKind;
  /** One-word label for the pill itself. */
  label: string;
  /** Sentence-form description for the popover header. */
  description: string;
  /** Visual severity, used for color. */
  tone: 'neutral' | 'progress' | 'good' | 'warn' | 'bad';
  syncMode: SyncMode;
  encryption: 'plaintext' | 'e2ee' | 'migrating-enable' | 'migrating-disable';
  connectivity: Connectivity;
  pendingChanges: number;
  user: AuthState;
  lastSynced: Date | null;
  lastPullAt: Date | null;
  lastPushAt: Date | null;
  lastError: string | null;
  /** Migration progress, when applicable. */
  migration?: {
    direction: 'enable' | 'disable';
    paused: boolean;
    error?: string;
    encryptedCount?: number;
    plaintextCount?: number;
    /** Live backfill progress: records converted / total, and the rounded
     * percent (null when no total has been reported yet). */
    recordsConverted?: number;
    recordsTotal?: number;
    percent: number | null;
  };
};

/** Rounded percent for a converted/total pair, or null when not yet known. */
function progressPercent(converted?: number, total?: number): number | null {
  if (!total || total <= 0 || converted == null) return null;
  return Math.min(100, Math.round((converted / total) * 100));
}

function encryptionOf(syncMode: SyncMode): SyncIndicator['encryption'] {
  switch (syncMode) {
    case 'e2ee':
      return 'e2ee';
    case 'migrating_to_e2ee':
      return 'migrating-enable';
    case 'migrating_to_plain':
      return 'migrating-disable';
    default:
      return 'plaintext';
  }
}

function pickKind(args: {
  auth: AuthState;
  conn: Connectivity;
  status: SyncStatus;
  syncMode: SyncMode;
  locked: boolean;
  outbox: number;
  migrationPaused: boolean;
  isMigrating: boolean;
  licenseActive: boolean | null;
}): SyncKind {
  const { auth, conn, status, syncMode, locked, outbox, migrationPaused, isMigrating, licenseActive } = args;
  if (auth.kind === 'loading') return 'auth-loading';
  // Offline beats signed-out: you can't sign in while offline, so showing
  // "Sign in to sync" would be useless guidance.
  if (conn === 'offline') return 'offline';
  if (auth.kind === 'signed-out-expired') return 'signed-out-expired';
  if (auth.kind === 'signed-out') return 'signed-out';
  // No active license: cloud sync is intentionally skipped. Surface this as a
  // distinct neutral state rather than letting it fall through to 'error'.
  if (licenseActive === false) return 'no-license';
  if (conn === 'connecting') return 'connecting';
  if (migrationPaused) return 'migration-paused';
  if (isMigrating) return 'migrating';
  if (syncMode === 'e2ee' && locked) return 'locked';
  if (status === 'syncing') return 'syncing';
  if (status === 'error') return 'error';
  if (outbox > 0) return 'pending';
  return 'synced';
}

function describe(kind: SyncKind, outbox: number, syncMode: SyncMode, percent: number | null = null): { label: string; description: string; tone: SyncIndicator['tone'] } {
  switch (kind) {
    case 'auth-loading':
      return { label: 'Loading', description: 'Checking your sign-in…', tone: 'neutral' };
    case 'signed-out':
      return { label: 'Signed out', description: 'Sign in to sync your data across devices.', tone: 'neutral' };
    case 'signed-out-expired':
      return { label: 'Signed out', description: 'Your session expired. Sign in again to resume sync.', tone: 'warn' };
    case 'connecting':
      return { label: 'Connecting', description: 'Reaching the sync server…', tone: 'progress' };
    case 'offline':
      return { label: 'Offline', description: 'No connection. Your edits are saved locally and will sync when you reconnect.', tone: 'warn' };
    case 'no-license':
      return { label: 'No license', description: 'Cloud sync needs a license. Claim one in Settings → License. Your data is saved locally.', tone: 'neutral' };
    case 'locked':
      return { label: 'Locked', description: 'Enter your passphrase to resume encrypted sync.', tone: 'warn' };
    case 'migration-paused':
      return { label: 'Migration paused', description: 'An encryption migration was interrupted. Enter your passphrase to resume.', tone: 'warn' };
    case 'migrating': {
      const enabling = syncMode === 'migrating_to_e2ee';
      const pct = percent != null ? ` ${percent}%` : '';
      return {
        label: `${enabling ? 'Encrypting' : 'Decrypting'}${pct}`,
        description: enabling ? 'Encrypting your data for end-to-end encryption…' : 'Switching back to plaintext sync…',
        tone: 'progress',
      };
    }
    case 'syncing':
      return { label: 'Syncing', description: 'Uploading and downloading changes…', tone: 'progress' };
    case 'pending':
      return {
        label: `${outbox} pending`,
        description: `${outbox} change${outbox === 1 ? '' : 's'} waiting to upload.`,
        tone: 'progress',
      };
    case 'error':
      return { label: 'Error', description: 'The last sync failed. Will retry automatically.', tone: 'bad' };
    case 'synced':
      return { label: 'Synced', description: 'Everything up to date.', tone: 'good' };
  }
}

export const syncIndicator: Readable<SyncIndicator> = derived(
  [
    syncStatus,
    connectivity,
    lastSynced,
    lastPullAt,
    lastPushAt,
    lastSyncError,
    outboxCount,
    authState,
    profileStore,
    sessionLocked,
    licenseActive,
  ],
  ([
    $syncStatus,
    $connectivity,
    $lastSynced,
    $lastPullAt,
    $lastPushAt,
    $lastError,
    $outboxCount,
    $auth,
    $profile,
    $locked,
    $licenseActive,
  ]) => {
    const syncMode = getProfileSyncMode($profile);
    const migrationState = $profile?.e2eeMigration;
    const isMigrating = syncMode === 'migrating_to_e2ee' || syncMode === 'migrating_to_plain';
    const migrationPaused = isMigrating && !!migrationState?.lastError;
    const percent = progressPercent(migrationState?.recordsConverted, migrationState?.recordsTotal);

    const kind = pickKind({
      auth: $auth,
      conn: $connectivity,
      status: $syncStatus,
      syncMode,
      locked: $locked,
      outbox: $outboxCount,
      migrationPaused,
      isMigrating,
      licenseActive: $licenseActive,
    });

    const { label, description, tone } = describe(kind, $outboxCount, syncMode, percent);

    return {
      kind,
      label,
      description,
      tone,
      syncMode,
      encryption: encryptionOf(syncMode),
      connectivity: $connectivity,
      pendingChanges: $outboxCount,
      user: $auth,
      lastSynced: $lastSynced,
      lastPullAt: $lastPullAt,
      lastPushAt: $lastPushAt,
      lastError: $lastError,
      migration: isMigrating && migrationState
        ? {
            direction: (migrationState.direction ?? 'enable') as 'enable' | 'disable',
            paused: migrationPaused,
            error: migrationState.lastError,
            encryptedCount: migrationState.encryptedEventCount,
            plaintextCount: migrationState.plaintextEventCount,
            recordsConverted: migrationState.recordsConverted,
            recordsTotal: migrationState.recordsTotal,
            percent,
          }
        : undefined,
    } satisfies SyncIndicator;
  },
);

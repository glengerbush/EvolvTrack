import { beginDeviceDataErasure } from '$lib/security/device-data-erasure';
import { syncNow } from '$lib/sync/sync-orchestrator';
import {
  getPendingOutgoingChanges,
  type PendingOutgoingChanges,
} from '$lib/sync/pending-outgoing-changes';
import { supabase } from '$lib/auth/supabase';

export type LogoutStrategy = 'require-synced' | 'sync-first' | 'discard';

export type LogoutResult =
  | { status: 'complete' }
  | { status: 'confirmation-required'; pending: PendingOutgoingChanges }
  | { status: 'sync-incomplete'; pending: PendingOutgoingChanges };

async function completeLogout(): Promise<LogoutResult> {
  await beginDeviceDataErasure(async () => {
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Server reachability never blocks Device Data Erasure.
    }
  });
  return { status: 'complete' };
}

/**
 * Execute logout only under the person's explicit pending-change strategy.
 * The authoritative outgoing changes are checked again after an attempted sync.
 */
export async function logoutCurrentDevice(strategy: LogoutStrategy): Promise<LogoutResult> {
  let pending = await getPendingOutgoingChanges();

  if (pending.total > 0 && strategy === 'require-synced') {
    return { status: 'confirmation-required', pending };
  }

  if (pending.total > 0 && strategy === 'sync-first') {
    await syncNow();
    pending = await getPendingOutgoingChanges();
    if (pending.total > 0) return { status: 'sync-incomplete', pending };
  }

  return completeLogout();
}

import type { AuthState } from '$lib/stores/authStore';

/**
 * Decide whether a visitor hitting one of the public entry pages — the
 * marketing landing (`/`) or the auth screen (`/auth`, the PWA `start_url`) —
 * should be sent straight into the app (`/app`) instead.
 *
 * The PWA opens at `/auth` on every cold launch, so this runs constantly. We
 * skip the entry page for people who are clearly returning users:
 *
 * - `signed-in`     — a restored account session; go to their app.
 * - in-demo mode    — continue the demo already in progress.
 * - `signed-out` with local data — a no-account user who has tracked data on
 *   this device (data lives in IndexedDB, which survives the iOS swipe-away
 *   localStorage wipe), so they're a returning offline user.
 *
 * Everyone else stays on the entry page: a genuinely fresh visitor (who should
 * see login / signup / "continue without an account"), or a
 * `signed-out-expired` account whose dead session is handled separately by the
 * layout.
 *
 * Pure on purpose: the async facts (settled auth state, demo flag, presence of
 * local data) are resolved by the caller and passed in, so this stays trivially
 * testable. The async resolution lives in `resolveAppEntry.ts`.
 */
export function shouldEnterApp(
  auth: AuthState['kind'],
  isDemo: boolean,
  hasLocalData: boolean,
): boolean {
  if (auth === 'signed-in') return true;
  if (isDemo) return true;
  if (auth === 'signed-out' && hasLocalData) return true;
  return false;
}

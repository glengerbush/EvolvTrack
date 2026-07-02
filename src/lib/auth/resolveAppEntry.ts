import { get } from 'svelte/store';
import { awaitSettledAuth } from '$lib/stores/authStore';
import { isDemoMode } from '$lib/stores/demoStore';
import { getAllEntries, getAllPrescriptions } from '$lib/domain/repo';
import { shouldEnterApp } from './appEntry';

/**
 * Resolve the async facts a public entry page (`/` or `/auth`) needs to decide
 * whether to skip itself and drop the visitor straight into `/app`.
 *
 * Waits for a settled (non-`loading`) auth state — the session is restored
 * asynchronously from IndexedDB on boot, so reading it eagerly would mis-classify
 * a returning user as signed-out. Only probes the local DB when it actually
 * matters (a no-account, non-demo visitor), keeping the fast paths cheap.
 *
 * `honorDemo` (default true) controls whether an active demo alone triggers
 * entry — see `shouldEnterApp` for why `/` passes `false`. Regardless of
 * `honorDemo`, an active demo still skips the local-data probe: demo mode
 * reseeds the same IndexedDB tables, so without this a demo visitor's seeded
 * rows would be misread as "real returning-user data" and redirect anyway.
 */
export async function resolveAppEntry(honorDemo: boolean = true): Promise<boolean> {
  const isDemo = get(isDemoMode);
  const auth = await awaitSettledAuth();
  const hasLocalData =
    auth.kind === 'signed-out' && !isDemo
      ? (await Promise.all([getAllEntries(), getAllPrescriptions()])).some(
          (rows) => rows.length > 0,
        )
      : false;
  return shouldEnterApp(auth.kind, isDemo, hasLocalData, honorDemo);
}

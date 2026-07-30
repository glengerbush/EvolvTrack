import { get, readable } from 'svelte/store';
import type { User } from '@supabase/supabase-js';
import { browser } from '$app/environment';
import { supabase } from '$lib/auth/supabase';

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'signed-out-expired' }
  | { kind: 'signed-in'; user: User };

/**
 * Reactive Supabase auth state. Starts as `loading` until the first
 * `getSession()` resolves, then transitions on every `onAuthStateChange` event.
 *
 * `signed-out-expired` is distinct from `signed-out`: the session ended after
 * the user was signed in (token expired, password changed elsewhere, etc.).
 * That's the case we want to nag about with a banner; a fresh start with no
 * session is just the unauthenticated home state.
 */
export const authState = browser
  ? readable<AuthState>({ kind: 'loading' }, (set) => {
      let wasSignedIn = false;

      void supabase.auth
        .getSession()
        .then(({ data }) => {
          if (data.session?.user) {
            wasSignedIn = true;
            set({ kind: 'signed-in', user: data.session.user });
          } else {
            set({ kind: 'signed-out' });
          }
        })
        .catch((cause) => {
          // Supabase persists the browser session in IndexedDB. If that read is
          // unavailable or corrupt, do not leave every route waiting forever
          // in `loading`; fail closed and present the signed-out experience.
          console.error('Failed to restore the authentication session:', cause);
          set({ kind: 'signed-out' });
        });

      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          wasSignedIn = true;
          set({ kind: 'signed-in', user: session.user });
        } else if (wasSignedIn) {
          set({ kind: 'signed-out-expired' });
        } else {
          set({ kind: 'signed-out' });
        }
      });

      return () => sub.subscription.unsubscribe();
    })
  : readable<AuthState>({ kind: 'loading' });

/**
 * Resolve the first settled (non-`loading`) auth state. The static SPA reads the
 * Supabase session asynchronously from IndexedDB on boot, so any code that needs
 * to make a one-shot routing decision must wait rather than mis-read the initial
 * `loading` state as signed-out.
 */
export function awaitSettledAuth(): Promise<AuthState> {
  const current = get(authState);
  if (current.kind !== 'loading') return Promise.resolve(current);

  return new Promise((resolve) => {
    let done = false;
    let unsub = () => {};
    unsub = authState.subscribe((s) => {
      if (done || s.kind === 'loading') return;
      done = true;
      resolve(s);
      unsub();
    });
    if (done) unsub();
  });
}

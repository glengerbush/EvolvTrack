import { readable, writable } from 'svelte/store';
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

      void supabase.auth.getSession().then(({ data }) => {
        if (data.session?.user) {
          wasSignedIn = true;
          set({ kind: 'signed-in', user: data.session.user });
        } else {
          set({ kind: 'signed-out' });
        }
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

/** Dismiss the "your session expired" banner without signing back in. */
const _dismissed = writable<boolean>(false);
export const expiredBannerDismissed = {
  subscribe: _dismissed.subscribe,
  dismiss() {
    _dismissed.set(true);
  },
  reset() {
    _dismissed.set(false);
  },
};

// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { durableGet, durableSet } from '$lib/db/durableKv';

const h = vi.hoisted(() => ({
  signInWithPasswordMock: vi.fn(),
  signInWithOtpMock: vi.fn(),
  signUpMock: vi.fn(),
  signOutMock: vi.fn(),
  resetPasswordForEmailMock: vi.fn(),
  getUserMock: vi.fn(),
  updateUserMock: vi.fn(),
  rpcMock: vi.fn(),
  dbDeleteMock: vi.fn(),
  dbCloseMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => {
  h.createClientMock.mockImplementation(() => ({
    auth: {
      signInWithPassword: h.signInWithPasswordMock,
      signInWithOtp: h.signInWithOtpMock,
      signUp: h.signUpMock,
      signOut: h.signOutMock,
      resetPasswordForEmail: h.resetPasswordForEmailMock,
      getUser: h.getUserMock,
      updateUser: h.updateUserMock,
    },
    rpc: h.rpcMock,
  }));
  return { createClient: h.createClientMock };
});

vi.mock('$lib/db/schema', () => ({
  db: {
    delete: (...args: unknown[]) => h.dbDeleteMock(...args),
    close: (...args: unknown[]) => h.dbCloseMock(...args),
  },
}));

import {
  WIPE_DB_ON_BOOT_KEY,
  changeLoginPassword,
  deleteAccountAndClearLocalData,
  logoutAndClearLocalData,
  requestPasswordReset,
  signInWithMagicLink,
  signInWithPassword,
  signUpWithPassword,
  supabase,
} from './supabase';

beforeEach(() => {
  h.signInWithPasswordMock.mockReset();
  h.signInWithPasswordMock.mockResolvedValue({ data: null, error: null });
  h.signInWithOtpMock.mockReset();
  h.signInWithOtpMock.mockResolvedValue({ data: null, error: null });
  h.signUpMock.mockReset();
  h.signUpMock.mockResolvedValue({ data: null, error: null });
  h.signOutMock.mockReset();
  h.signOutMock.mockResolvedValue({ error: null });
  h.resetPasswordForEmailMock.mockReset();
  h.resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null });
  h.getUserMock.mockReset();
  h.getUserMock.mockResolvedValue({
    data: { user: { email: 'alice@example.com' } },
    error: null,
  });
  h.updateUserMock.mockReset();
  h.updateUserMock.mockResolvedValue({ data: {}, error: null });
  h.rpcMock.mockReset();
  h.rpcMock.mockResolvedValue({ data: null, error: null });
  h.dbDeleteMock.mockReset();
  h.dbDeleteMock.mockResolvedValue(undefined);
  h.dbCloseMock.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('supabase client', () => {
  it('was constructed via createClient and exposes the mocked auth surface', () => {
    expect(h.createClientMock).toHaveBeenCalled();
    expect(supabase.auth.signInWithPassword).toBe(h.signInWithPasswordMock);
  });
});

describe('signInWithPassword identifier normalization', () => {
  it('passes through an explicit email identifier verbatim (lowercased)', async () => {
    await signInWithPassword('Alice@Example.COM', 'pw');
    expect(h.signInWithPasswordMock).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'pw',
    });
  });

  it('synthesizes a local domain email for username-only identifiers', async () => {
    await signInWithPassword('Alice Smith', 'pw');
    const [arg] = h.signInWithPasswordMock.mock.calls[0];
    expect(arg.email).toBe('alice-smith@users.evolvtrack.com');
    expect(arg.password).toBe('pw');
  });

  it('strips leading/trailing punctuation and collapses runs to single dashes', async () => {
    await signInWithPassword('  ___weird!!user??  ', 'pw');
    const [arg] = h.signInWithPasswordMock.mock.calls[0];
    expect(arg.email).toBe('weird-user@users.evolvtrack.com');
  });

  it('falls back to "user" when normalization strips everything', async () => {
    await signInWithPassword('!!!', 'pw');
    const [arg] = h.signInWithPasswordMock.mock.calls[0];
    expect(arg.email).toBe('user@users.evolvtrack.com');
  });
});

describe('signInWithMagicLink', () => {
  it('calls signInWithOtp with the email and a callback redirect', async () => {
    await signInWithMagicLink('a@b.com');
    expect(h.signInWithOtpMock).toHaveBeenCalledTimes(1);
    const [arg] = h.signInWithOtpMock.mock.calls[0];
    expect(arg.email).toBe('a@b.com');
    expect(arg.options.emailRedirectTo).toMatch(/\/auth\/callback$/);
  });
});

describe('signUpWithPassword', () => {
  it('marks username sign-ups with usedGeneratedEmail=true and a synthetic email', async () => {
    await signUpWithPassword('Alice', 'pw');
    const [arg] = h.signUpMock.mock.calls[0];
    expect(arg.email).toBe('alice@users.evolvtrack.com');
    expect(arg.password).toBe('pw');
    expect(arg.options.data).toMatchObject({
      username: 'alice',
      signupIdentifier: 'alice',
      usedGeneratedEmail: true,
    });
    expect(arg.options.emailRedirectTo).toMatch(/\/auth\/callback$/);
  });

  it('marks email sign-ups with usedGeneratedEmail=false and extracts username from local part', async () => {
    await signUpWithPassword('Alice@Example.com', 'pw');
    const [arg] = h.signUpMock.mock.calls[0];
    expect(arg.email).toBe('alice@example.com');
    expect(arg.options.data).toMatchObject({
      username: 'alice',
      signupIdentifier: 'alice@example.com',
      usedGeneratedEmail: false,
    });
  });
});

describe('requestPasswordReset', () => {
  it('sends a reset email and asks Supabase to redirect to /auth/reset', async () => {
    const { error } = await requestPasswordReset('Alice@Example.COM');
    expect(error).toBeNull();
    expect(h.resetPasswordForEmailMock).toHaveBeenCalledTimes(1);
    const [email, options] = h.resetPasswordForEmailMock.mock.calls[0];
    expect(email).toBe('alice@example.com');
    expect(options.redirectTo).toMatch(/\/auth\/reset$/);
  });

  it('refuses identifiers that are not email addresses', async () => {
    const { error } = await requestPasswordReset('alice');
    expect(error?.message).toMatch(/email/i);
    expect(h.resetPasswordForEmailMock).not.toHaveBeenCalled();
  });

  it('refuses synthetic username-domain addresses (no real inbox)', async () => {
    const { error } = await requestPasswordReset('alice@users.evolvtrack.com');
    expect(error?.message).toMatch(/email/i);
    expect(h.resetPasswordForEmailMock).not.toHaveBeenCalled();
  });

  it('surfaces Supabase errors verbatim', async () => {
    h.resetPasswordForEmailMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'rate limit hit' },
    });
    const { error } = await requestPasswordReset('a@b.com');
    expect(error?.message).toBe('rate limit hit');
  });
});

describe('changeLoginPassword', () => {
  it('reauthenticates with the current password before changing it', async () => {
    const { error } = await changeLoginPassword('old-password', 'new-password');

    expect(error).toBeNull();
    expect(h.signInWithPasswordMock).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'old-password',
    });
    expect(h.updateUserMock).toHaveBeenCalledWith({ password: 'new-password' });
    expect(h.signInWithPasswordMock.mock.invocationCallOrder[0]).toBeLessThan(
      h.updateUserMock.mock.invocationCallOrder[0],
    );
  });

  it('does not update when the current password is wrong', async () => {
    h.signInWithPasswordMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid login credentials' },
    });

    const { error } = await changeLoginPassword('wrong', 'new-password');

    expect(error?.message).toBe('Current password did not match.');
    expect(h.updateUserMock).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    h.getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });

    const { error } = await changeLoginPassword('old', 'new');

    expect(error?.message).toBe('You must be signed in.');
    expect(h.signInWithPasswordMock).not.toHaveBeenCalled();
    expect(h.updateUserMock).not.toHaveBeenCalled();
  });

  it('returns password-policy errors from Supabase', async () => {
    h.updateUserMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Password should be at least 8 characters.' },
    });

    const { error } = await changeLoginPassword('old-password', 'short');

    expect(error?.message).toMatch(/at least 8 characters/i);
  });
});

describe('logoutAndClearLocalData', () => {
  it('signs out locally, wipes IndexedDB inline, and clears local/session storage', async () => {
    localStorage.setItem('k', 'v');
    sessionStorage.setItem('k', 'v');

    await logoutAndClearLocalData();

    // `scope: 'local'` ends this device's session only. A 'global' signout
    // would invalidate every other device's refresh token and surprise users
    // who expected the laptop logout to leave the phone PWA alone.
    expect(h.signOutMock).toHaveBeenCalledWith({ scope: 'local' });
    // The DB is force-closed (to release liveQuery subscribers) then deleted
    // inline, so the plaintext local tables are gone before the user can
    // inspect them — not deferred to the next boot.
    expect(h.dbCloseMock).toHaveBeenCalled();
    expect(h.dbDeleteMock).toHaveBeenCalled();
    expect(localStorage.getItem('k')).toBeNull();
    expect(sessionStorage.getItem('k')).toBeNull();
    // On a successful inline wipe the boot-guard sentinel is cleared again —
    // there's nothing left for the next boot to do.
    expect(localStorage.getItem(WIPE_DB_ON_BOOT_KEY)).toBeNull();
  });

  it('wipes the durable IndexedDB auth store (Supabase session + DEK)', async () => {
    // The auth session and E2EE key now live in the separate `evolvtrack-auth`
    // IndexedDB database, which the health-data `db.delete()` does not touch.
    // Logout must clear it explicitly, or a logged-out device would reopen
    // still holding a usable session.
    await durableSet('sb-auth-token', 'SESSION');
    await durableSet('et.session.dek', 'DEK');

    await logoutAndClearLocalData();

    expect(await durableGet('sb-auth-token')).toBeNull();
    expect(await durableGet('et.session.dek')).toBeNull();
  });

  it('leaves the boot-guard sentinel set when the inline delete is blocked', async () => {
    // A second PWA tab can hold the connection open and block the delete. The
    // sentinel must survive so hooks.client.ts retries the wipe on next boot.
    h.dbDeleteMock.mockRejectedValueOnce(new Error('blocked'));

    await logoutAndClearLocalData();

    expect(h.dbCloseMock).toHaveBeenCalled();
    expect(localStorage.getItem(WIPE_DB_ON_BOOT_KEY)).toBe('1');
  });

  it('still wipes local storage and the DB when the server signOut fails', async () => {
    // Regression: if signOut threw (offline, server down, expired token), the
    // original implementation aborted local cleanup and the persisted session
    // key — plus everything else — stayed on disk after the user "logged out".
    localStorage.setItem('et.session.key', 'PERSISTED_KEY');
    localStorage.setItem('et.salt', 'SALT');
    h.signOutMock.mockRejectedValueOnce(new Error('network down'));

    await logoutAndClearLocalData();

    expect(localStorage.getItem('et.session.key')).toBeNull();
    expect(localStorage.getItem('et.salt')).toBeNull();
    expect(h.dbDeleteMock).toHaveBeenCalled();
    expect(localStorage.getItem(WIPE_DB_ON_BOOT_KEY)).toBeNull();
  });
});

describe('deleteAccountAndClearLocalData', () => {
  it('deletes the server account and wipes local data without signing out an invalid token', async () => {
    localStorage.setItem('private-data', 'present');

    await deleteAccountAndClearLocalData();

    expect(h.rpcMock).toHaveBeenCalledWith('delete_self');
    expect(h.signOutMock).not.toHaveBeenCalled();
    expect(h.dbCloseMock).toHaveBeenCalled();
    expect(h.dbDeleteMock).toHaveBeenCalled();
    expect(localStorage.getItem('private-data')).toBeNull();
  });

  it('preserves local state when server-side account deletion fails', async () => {
    h.rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Deletion denied' },
    });
    localStorage.setItem('private-data', 'present');

    await expect(deleteAccountAndClearLocalData()).rejects.toThrow('Deletion denied');

    expect(h.signOutMock).not.toHaveBeenCalled();
    expect(h.dbDeleteMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('private-data')).toBe('present');
  });
});

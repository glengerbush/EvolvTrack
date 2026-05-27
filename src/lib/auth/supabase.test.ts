// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  signInWithPasswordMock: vi.fn(),
  signInWithOtpMock: vi.fn(),
  signUpMock: vi.fn(),
  signOutMock: vi.fn(),
  resetPasswordForEmailMock: vi.fn(),
  dbDeleteMock: vi.fn(),
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
    },
  }));
  return { createClient: h.createClientMock };
});

vi.mock('$lib/db/schema', () => ({
  db: { delete: (...args: unknown[]) => h.dbDeleteMock(...args) },
}));

import {
  WIPE_DB_ON_BOOT_KEY,
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
  h.dbDeleteMock.mockReset();
  h.dbDeleteMock.mockResolvedValue(undefined);
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

describe('logoutAndClearLocalData', () => {
  it('signs out locally, sets the wipe-on-boot sentinel, and clears local/session storage', async () => {
    localStorage.setItem('k', 'v');
    sessionStorage.setItem('k', 'v');

    await logoutAndClearLocalData();

    // `scope: 'local'` ends this device's session only. A 'global' signout
    // would invalidate every other device's refresh token and surprise users
    // who expected the laptop logout to leave the phone PWA alone.
    expect(h.signOutMock).toHaveBeenCalledWith({ scope: 'local' });
    // db.delete() is deferred to the boot guard (hooks.client.ts) — inline
    // delete cannot complete while module-scoped liveQuery subscribers hold
    // the database open, so it must NOT be called here.
    expect(h.dbDeleteMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('k')).toBeNull();
    expect(sessionStorage.getItem('k')).toBeNull();
    // The sentinel must survive the storage clear so the next boot can act on it.
    expect(localStorage.getItem(WIPE_DB_ON_BOOT_KEY)).toBe('1');
  });

  it('still wipes local storage when the server signOut fails', async () => {
    // Regression: if signOut threw (offline, server down, expired token), the
    // original implementation aborted local cleanup and the persisted session
    // key — plus everything else — stayed on disk after the user "logged out".
    localStorage.setItem('et.session.key', 'PERSISTED_KEY');
    localStorage.setItem('et.salt', 'SALT');
    h.signOutMock.mockRejectedValueOnce(new Error('network down'));

    await logoutAndClearLocalData();

    expect(localStorage.getItem('et.session.key')).toBeNull();
    expect(localStorage.getItem('et.salt')).toBeNull();
    expect(localStorage.getItem(WIPE_DB_ON_BOOT_KEY)).toBe('1');
  });
});
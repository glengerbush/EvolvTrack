// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  signInWithPasswordMock: vi.fn(),
  signInWithOtpMock: vi.fn(),
  signUpMock: vi.fn(),
  signOutMock: vi.fn(),
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
    },
  }));
  return { createClient: h.createClientMock };
});

vi.mock('$lib/db/schema', () => ({
  db: { delete: (...args: unknown[]) => h.dbDeleteMock(...args) },
}));

import {
  logoutAndClearLocalData,
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

describe('logoutAndClearLocalData', () => {
  it('signs out globally, deletes the DB, and clears local/session storage', async () => {
    localStorage.setItem('k', 'v');
    sessionStorage.setItem('k', 'v');

    await logoutAndClearLocalData();

    expect(h.signOutMock).toHaveBeenCalledWith({ scope: 'global' });
    expect(h.dbDeleteMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('k')).toBeNull();
    expect(sessionStorage.getItem('k')).toBeNull();
  });

  it('completes even if the DB delete hangs (the 1.5s timeout race wins)', async () => {
    h.dbDeleteMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    const promise = logoutAndClearLocalData();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
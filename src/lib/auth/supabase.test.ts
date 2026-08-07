// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { durableClear, durableGet, durableSet } from '$lib/db/durableKv';

const h = vi.hoisted(() => ({
  signInWithPasswordMock: vi.fn(),
  signInWithOtpMock: vi.fn(),
  signUpMock: vi.fn(),
  signOutMock: vi.fn(),
  resetPasswordForEmailMock: vi.fn(),
  getUserMock: vi.fn(),
  getSessionMock: vi.fn(),
  updateUserMock: vi.fn(),
  stopAutoRefreshMock: vi.fn(),
  rpcMock: vi.fn(),
  createClientMock: vi.fn(),
  prepareErasureMock: vi.fn(),
  confirmErasureMock: vi.fn(),
  cancelErasureMock: vi.fn(),
  pendingErasureMock: vi.fn(),
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
      getSession: h.getSessionMock,
      updateUser: h.updateUserMock,
      stopAutoRefresh: h.stopAutoRefreshMock,
    },
    rpc: h.rpcMock,
  }));
  return { createClient: h.createClientMock };
});

vi.mock('$lib/security/device-data-erasure', () => ({
  prepareAccountDeletionErasure: h.prepareErasureMock,
  confirmAccountDeletionErasure: h.confirmErasureMock,
  cancelPreparedAccountDeletionErasure: h.cancelErasureMock,
  getPendingDeviceDataErasure: h.pendingErasureMock,
}));

import {
  changeLoginPassword,
  deleteAccountAndEraseDeviceData,
  resumePreparedAccountDeletion,
  revokeLocalAuthSessionForDeviceDataErasure,
  requestPasswordReset,
  signInWithMagicLink,
  signInWithPassword,
  signUpWithPassword,
  supabase,
} from './supabase';

beforeEach(async () => {
  await durableClear();
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
  h.getSessionMock.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  h.updateUserMock.mockReset();
  h.updateUserMock.mockResolvedValue({ data: {}, error: null });
  h.stopAutoRefreshMock.mockReset().mockResolvedValue(undefined);
  h.rpcMock.mockReset();
  h.rpcMock.mockResolvedValue({ data: null, error: null });
  h.prepareErasureMock.mockReset().mockResolvedValue('delete-1');
  h.confirmErasureMock.mockReset().mockResolvedValue(undefined);
  h.cancelErasureMock.mockReset().mockResolvedValue(undefined);
  h.pendingErasureMock.mockReset().mockResolvedValue(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('Device Data Erasure auth revocation', () => {
  it('drains refresh and clears the durable auth session without network logout', async () => {
    await durableSet('sb-auth-token', 'SESSION');

    await revokeLocalAuthSessionForDeviceDataErasure();

    expect(h.stopAutoRefreshMock).toHaveBeenCalledOnce();
    expect(h.getSessionMock).toHaveBeenCalledOnce();
    expect(await durableGet('sb-auth-token')).toBeNull();
    expect(h.signOutMock).not.toHaveBeenCalled();
  });
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

describe('deleteAccountAndEraseDeviceData', () => {
  it('deletes the server account and performs Device Data Erasure without signing out an invalid token', async () => {
    await deleteAccountAndEraseDeviceData();

    expect(h.prepareErasureMock).toHaveBeenCalledOnce();
    expect(h.rpcMock).toHaveBeenCalledWith('delete_self', { p_request_id: 'delete-1' });
    expect(h.signOutMock).not.toHaveBeenCalled();
    expect(h.confirmErasureMock).toHaveBeenCalledWith('delete-1');
    expect(h.prepareErasureMock.mock.invocationCallOrder[0]).toBeLessThan(
      h.rpcMock.mock.invocationCallOrder[0],
    );
  });

  it('preserves local state when server-side account deletion fails', async () => {
    h.rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'Deletion denied' } })
      .mockResolvedValueOnce({ data: false, error: null });
    localStorage.setItem('private-data', 'present');

    await expect(deleteAccountAndEraseDeviceData()).rejects.toThrow('Deletion denied');

    expect(h.signOutMock).not.toHaveBeenCalled();
    expect(h.confirmErasureMock).not.toHaveBeenCalled();
    expect(h.cancelErasureMock).toHaveBeenCalledWith('delete-1');
    expect(localStorage.getItem('private-data')).toBe('present');
  });

  it('finishes local erasure from a server receipt after a crash gap', async () => {
    h.pendingErasureMock.mockResolvedValueOnce({
      operationId: 'delete-1',
      phase: 'account-deletion-prepared',
    });
    h.rpcMock.mockResolvedValueOnce({ data: true, error: null });

    await resumePreparedAccountDeletion();

    expect(h.rpcMock).toHaveBeenCalledWith('account_deletion_confirmed', {
      p_request_id: 'delete-1',
    });
    expect(h.confirmErasureMock).toHaveBeenCalledWith('delete-1');
    expect(h.rpcMock).not.toHaveBeenCalledWith('delete_self', expect.anything());
  });

  it('uses the receipt when the deletion response itself was lost', async () => {
    h.rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({ data: true, error: null });

    await deleteAccountAndEraseDeviceData();

    expect(h.confirmErasureMock).toHaveBeenCalledWith('delete-1');
    expect(h.cancelErasureMock).not.toHaveBeenCalled();
  });

  it('retries a prepared deletion when no server receipt exists yet', async () => {
    h.pendingErasureMock.mockResolvedValueOnce({
      operationId: 'delete-1',
      phase: 'account-deletion-prepared',
    });
    h.rpcMock
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: 'delete-1', error: null });

    await resumePreparedAccountDeletion();

    expect(h.rpcMock).toHaveBeenNthCalledWith(2, 'delete_self', {
      p_request_id: 'delete-1',
    });
    expect(h.confirmErasureMock).toHaveBeenCalledWith('delete-1');
  });
});

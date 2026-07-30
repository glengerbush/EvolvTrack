import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  setLicenseActive: vi.fn(),
}));

vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    rpc: (...args: [string, unknown?]) => h.rpc(...args),
    auth: {
      getUser: () => h.getUser(),
      signInWithPassword: (args: unknown) => h.signInWithPassword(args),
    },
  },
}));

vi.mock('$lib/stores/syncStore', () => ({
  licenseActive: {
    set: (value: boolean) => h.setLicenseActive(value),
  },
}));

import {
  adminChangeTier,
  adminGenerateLicenses,
  adminGrantAdmin,
  adminGrantAdminByIdentifier,
  adminListAdmins,
  adminListLicenses,
  adminRevoke,
  adminRevokeAdmin,
  adminSetNote,
  amIAdmin,
  claimLicense,
  fetchLicenseStatus,
  refreshLicenseActive,
  regenerateCode,
  releaseLicense,
  verifyCurrentPassword,
} from './license';

const activeLicense = {
  license_id: 'license-1',
  tier: 'yearly',
  status: 'active',
  period_start: '2026-01-01T00:00:00Z',
  period_end: '2027-01-01T00:00:00Z',
  code_prefix: 'EVOLV-ABCD',
  claimed_at: '2026-01-01T00:00:00Z',
  is_active: true,
} as const;

beforeEach(() => {
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  h.getUser.mockReset().mockResolvedValue({
    data: { user: { email: 'alice@example.com' } },
  });
  h.signInWithPassword.mockReset().mockResolvedValue({ error: null });
  h.setLicenseActive.mockReset();
});

describe('license status and claims', () => {
  it('returns the first status row, or null when no license exists', async () => {
    h.rpc.mockResolvedValueOnce({ data: [activeLicense], error: null });
    await expect(fetchLicenseStatus()).resolves.toEqual(activeLicense);
    expect(h.rpc).toHaveBeenCalledWith('license_status');

    h.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(fetchLicenseStatus()).resolves.toBeNull();
  });

  it('refreshes the shared active flag for active and missing licenses', async () => {
    h.rpc.mockResolvedValueOnce({ data: [activeLicense], error: null });
    await expect(refreshLicenseActive()).resolves.toBe(true);
    expect(h.setLicenseActive).toHaveBeenLastCalledWith(true);

    h.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(refreshLicenseActive()).resolves.toBe(false);
    expect(h.setLicenseActive).toHaveBeenLastCalledWith(false);
  });

  it('claims a code and marks licensing active', async () => {
    const claim = {
      license_id: 'license-1',
      tier: 'yearly',
      status: 'active',
      period_end: null,
      code_prefix: 'EVOLV-ABCD',
    };
    h.rpc.mockResolvedValueOnce({ data: [claim], error: null });

    await expect(claimLicense('EVOLV-ABCDE')).resolves.toEqual(claim);
    expect(h.rpc).toHaveBeenCalledWith('claim_license', { p_code: 'EVOLV-ABCDE' });
    expect(h.setLicenseActive).toHaveBeenCalledWith(true);
  });

  it('rejects an empty claim response without marking licensing active', async () => {
    h.rpc.mockResolvedValueOnce({ data: [], error: null });

    await expect(claimLicense('EVOLV-ABCDE')).rejects.toThrow(
      'License claim returned no result.',
    );
    expect(h.setLicenseActive).not.toHaveBeenCalled();
  });

  it('releases a license and marks licensing inactive', async () => {
    await releaseLicense();

    expect(h.rpc).toHaveBeenCalledWith('release_license');
    expect(h.setLicenseActive).toHaveBeenCalledWith(false);
  });

  it('returns a newly regenerated code and validates its response type', async () => {
    h.rpc.mockResolvedValueOnce({ data: 'EVOLV-NEW-CODE', error: null });
    await expect(regenerateCode()).resolves.toBe('EVOLV-NEW-CODE');

    h.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(regenerateCode()).rejects.toThrow(
      'Unexpected response from regenerate_code.',
    );
  });
});

describe('license error handling', () => {
  it.each([
    ['not_authenticated', 'You must be signed in.'],
    ['invalid_code', 'Enter a license code.'],
    ['license_not_found', 'That code is not recognized. Check for typos.'],
    ['license_already_claimed', 'That license is already claimed by another account.'],
    ['license_revoked', 'That license has been revoked.'],
    ['no_license', 'You do not have a license to regenerate.'],
    ['not_admin', 'Admin access required.'],
    ['invalid_count', 'Count must be between 1 and 500.'],
    ['invalid_tier', 'Invalid tier.'],
    ['cannot_revoke_self', 'You cannot remove your own admin access.'],
    ['invalid_identifier', 'Enter a username, email, or user UUID.'],
    ['user_not_found', 'No account found for that username, email, or UUID.'],
    ['license_code_pepper missing', 'Server is misconfigured. Contact support.'],
  ])('maps %s to actionable copy', async (serverMessage, expected) => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: `P0001: ${serverMessage}` },
    });

    await expect(claimLicense('code')).rejects.toThrow(expected);
  });

  it('preserves unknown server errors', async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(fetchLicenseStatus()).rejects.toThrow('database unavailable');
  });
});

describe('password verification', () => {
  it('reauthenticates the current email with the supplied password', async () => {
    await verifyCurrentPassword('secret');

    expect(h.signInWithPassword).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'secret',
    });
  });

  it('requires a signed-in user with an email', async () => {
    h.getUser.mockResolvedValueOnce({ data: { user: null } });
    await expect(verifyCurrentPassword('secret')).rejects.toThrow(
      'You must be signed in.',
    );
  });

  it('does not expose the provider error when the password is wrong', async () => {
    h.signInWithPassword.mockResolvedValueOnce({
      error: { message: 'Invalid login credentials' },
    });
    await expect(verifyCurrentPassword('wrong')).rejects.toThrow(
      'Password did not match.',
    );
  });
});

describe('admin license RPCs', () => {
  it('checks admin status strictly', async () => {
    h.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(amIAdmin()).resolves.toBe(true);

    h.rpc.mockResolvedValueOnce({ data: 'true', error: null });
    await expect(amIAdmin()).resolves.toBe(false);
  });

  it('lists licenses with pagination and filtering', async () => {
    h.rpc.mockResolvedValueOnce({ data: [activeLicense], error: null });

    await expect(adminListLicenses('alice', 25, 50)).resolves.toEqual([activeLicense]);
    expect(h.rpc).toHaveBeenCalledWith('admin_list_licenses', {
      p_limit: 25,
      p_offset: 50,
      p_filter: 'alice',
    });
  });

  it('generates licenses with every supplied option', async () => {
    const generated = [{ license_id: 'license-1', code: 'EVOLV-X', code_prefix: 'EVOLV-X' }];
    h.rpc.mockResolvedValueOnce({ data: generated, error: null });

    await expect(
      adminGenerateLicenses('lifetime', 3, 'buyer', '2030-01-01T00:00:00Z'),
    ).resolves.toEqual(generated);
    expect(h.rpc).toHaveBeenCalledWith('admin_generate_licenses', {
      p_tier: 'lifetime',
      p_count: 3,
      p_note: 'buyer',
      p_period_end: '2030-01-01T00:00:00Z',
    });
  });

  it('forwards mutation parameters to their exact RPCs', async () => {
    await adminChangeTier('license-1', 'monthly', '2026-09-01');
    expect(h.rpc).toHaveBeenLastCalledWith('admin_change_tier', {
      p_license_id: 'license-1',
      p_new_tier: 'monthly',
      p_new_period_end: '2026-09-01',
    });

    await adminRevoke('license-1', 'refund');
    expect(h.rpc).toHaveBeenLastCalledWith('admin_revoke', {
      p_license_id: 'license-1',
      p_reason: 'refund',
    });

    await adminSetNote('license-1', 'priority');
    expect(h.rpc).toHaveBeenLastCalledWith('admin_set_note', {
      p_license_id: 'license-1',
      p_note: 'priority',
    });

    await adminGrantAdmin('user-1');
    expect(h.rpc).toHaveBeenLastCalledWith('admin_grant_admin', {
      p_user_id: 'user-1',
    });

    await adminRevokeAdmin('user-2');
    expect(h.rpc).toHaveBeenLastCalledWith('admin_revoke_admin', {
      p_user_id: 'user-2',
    });
  });

  it('lists admins and treats a null response as an empty list', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(adminListAdmins()).resolves.toEqual([]);
    expect(h.rpc).toHaveBeenCalledWith('admin_list_admins');
  });

  it('grants admin by identifier and validates the returned UUID', async () => {
    h.rpc.mockResolvedValueOnce({ data: 'user-1', error: null });
    await expect(adminGrantAdminByIdentifier('Alice')).resolves.toBe('user-1');
    expect(h.rpc).toHaveBeenCalledWith('admin_grant_admin_by_identifier', {
      p_identifier: 'Alice',
    });

    h.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(adminGrantAdminByIdentifier('Alice')).rejects.toThrow(
      'Unexpected response from admin_grant_admin_by_identifier.',
    );
  });

  it('propagates mapped admin RPC errors', async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'P0001: not_admin' },
    });

    await expect(adminListAdmins()).rejects.toThrow('Admin access required.');
  });
});

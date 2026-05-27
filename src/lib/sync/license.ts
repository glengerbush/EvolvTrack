import { supabase } from '$lib/auth/supabase';
import { licenseActive } from '$lib/stores/syncStore';

export type LicenseTier = 'monthly' | 'yearly' | 'lifetime';
export type LicenseStatus = 'unclaimed' | 'active' | 'expired' | 'revoked';

export interface LicenseStatusRow {
  license_id: string;
  tier: LicenseTier;
  status: LicenseStatus;
  period_start: string | null;
  period_end: string | null;
  code_prefix: string;
  claimed_at: string | null;
  is_active: boolean;
}

export interface ClaimResultRow {
  license_id: string;
  tier: LicenseTier;
  status: LicenseStatus;
  period_end: string | null;
  code_prefix: string;
}

/** Returns the calling user's license, or null if they have none. */
export async function fetchLicenseStatus(): Promise<LicenseStatusRow | null> {
  const { data, error } = await supabase.rpc('license_status');
  if (error) throw new Error(licenseErrorMessage(error.message));
  const rows = (data ?? []) as LicenseStatusRow[];
  return rows[0] ?? null;
}

/**
 * Fetches license status and mirrors `is_active` into the global
 * `licenseActive` store so the sync orchestrator and pill can react.
 * Returns true iff the user has an active license.
 */
export async function refreshLicenseActive(): Promise<boolean> {
  const status = await fetchLicenseStatus();
  const active = !!status?.is_active;
  licenseActive.set(active);
  return active;
}

export async function claimLicense(code: string): Promise<ClaimResultRow> {
  const { data, error } = await supabase.rpc('claim_license', { p_code: code });
  if (error) throw new Error(licenseErrorMessage(error.message));
  const rows = (data ?? []) as ClaimResultRow[];
  if (!rows[0]) throw new Error('License claim returned no result.');
  licenseActive.set(true);
  return rows[0];
}

export async function releaseLicense(): Promise<void> {
  const { error } = await supabase.rpc('release_license');
  if (error) throw new Error(licenseErrorMessage(error.message));
  licenseActive.set(false);
}

/** Returns the newly generated raw code. Shown exactly once. */
export async function regenerateCode(): Promise<string> {
  const { data, error } = await supabase.rpc('regenerate_code');
  if (error) throw new Error(licenseErrorMessage(error.message));
  if (typeof data !== 'string') throw new Error('Unexpected response from regenerate_code.');
  return data;
}

/** Re-verifies the current user's password against Supabase Auth. */
export async function verifyCurrentPassword(password: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getUser();
  const email = sessionData.user?.email;
  if (!email) throw new Error('You must be signed in.');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Password did not match.');
}

export interface AdminLicenseRow {
  license_id: string;
  code_prefix: string;
  tier: LicenseTier;
  status: LicenseStatus;
  claimed_by_user_id: string | null;
  claimed_by_email: string | null;
  claimed_at: string | null;
  period_start: string | null;
  period_end: string | null;
  buyer_email: string | null;
  note: string | null;
  created_at: string;
}

export interface AdminGeneratedCode {
  license_id: string;
  code: string;
  code_prefix: string;
}

export interface AdminInfo {
  user_id: string;
  email: string | null;
  granted_at: string;
}

export async function amIAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('am_i_admin');
  if (error) throw new Error(licenseErrorMessage(error.message));
  return data === true;
}

export async function adminListLicenses(
  filter: string | null = null,
  limit = 100,
  offset = 0,
): Promise<AdminLicenseRow[]> {
  const { data, error } = await supabase.rpc('admin_list_licenses', {
    p_limit: limit, p_offset: offset, p_filter: filter,
  });
  if (error) throw new Error(licenseErrorMessage(error.message));
  return (data ?? []) as AdminLicenseRow[];
}

export async function adminGenerateLicenses(
  tier: LicenseTier,
  count: number,
  note: string | null = null,
  periodEnd: string | null = null,
): Promise<AdminGeneratedCode[]> {
  const { data, error } = await supabase.rpc('admin_generate_licenses', {
    p_tier: tier, p_count: count, p_note: note, p_period_end: periodEnd,
  });
  if (error) throw new Error(licenseErrorMessage(error.message));
  return (data ?? []) as AdminGeneratedCode[];
}

export async function adminChangeTier(
  licenseId: string,
  newTier: LicenseTier,
  newPeriodEnd: string | null = null,
): Promise<void> {
  const { error } = await supabase.rpc('admin_change_tier', {
    p_license_id: licenseId, p_new_tier: newTier, p_new_period_end: newPeriodEnd,
  });
  if (error) throw new Error(licenseErrorMessage(error.message));
}

export async function adminRevoke(licenseId: string, reason: string | null = null): Promise<void> {
  const { error } = await supabase.rpc('admin_revoke', {
    p_license_id: licenseId, p_reason: reason,
  });
  if (error) throw new Error(licenseErrorMessage(error.message));
}

export async function adminSetNote(licenseId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('admin_set_note', {
    p_license_id: licenseId, p_note: note,
  });
  if (error) throw new Error(licenseErrorMessage(error.message));
}

export async function adminListAdmins(): Promise<AdminInfo[]> {
  const { data, error } = await supabase.rpc('admin_list_admins');
  if (error) throw new Error(licenseErrorMessage(error.message));
  return (data ?? []) as AdminInfo[];
}

export async function adminGrantAdmin(userId: string): Promise<void> {
  const { error } = await supabase.rpc('admin_grant_admin', { p_user_id: userId });
  if (error) throw new Error(licenseErrorMessage(error.message));
}

/**
 * Grants admin by username, email, or UUID. Username-only accounts are
 * resolved by the same normalization the client uses at sign-up
 * (see toAuthEmail in src/lib/auth/supabase.ts).
 */
export async function adminGrantAdminByIdentifier(identifier: string): Promise<string> {
  const { data, error } = await supabase.rpc('admin_grant_admin_by_identifier', {
    p_identifier: identifier,
  });
  if (error) throw new Error(licenseErrorMessage(error.message));
  if (typeof data !== 'string') throw new Error('Unexpected response from admin_grant_admin_by_identifier.');
  return data;
}

export async function adminRevokeAdmin(userId: string): Promise<void> {
  const { error } = await supabase.rpc('admin_revoke_admin', { p_user_id: userId });
  if (error) throw new Error(licenseErrorMessage(error.message));
}

function licenseErrorMessage(raw: string): string {
  const key = raw.replace(/^.*: /, '').trim();
  switch (key) {
    case 'not_authenticated': return 'You must be signed in.';
    case 'invalid_code': return 'Enter a license code.';
    case 'license_not_found': return 'That code is not recognized. Check for typos.';
    case 'license_already_claimed': return 'That license is already claimed by another account.';
    case 'license_revoked': return 'That license has been revoked.';
    case 'no_license': return 'You do not have a license to regenerate.';
    case 'not_admin': return 'Admin access required.';
    case 'invalid_count': return 'Count must be between 1 and 500.';
    case 'invalid_tier': return 'Invalid tier.';
    case 'cannot_revoke_self': return 'You cannot remove your own admin access.';
    case 'invalid_identifier': return 'Enter a username, email, or user UUID.';
    case 'user_not_found': return 'No account found for that username, email, or UUID.';
    case 'license_code_pepper missing': return 'Server is misconfigured. Contact support.';
    default: return raw;
  }
}

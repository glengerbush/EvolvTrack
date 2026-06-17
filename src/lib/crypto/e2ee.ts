import { cryptoWorker } from '$lib/crypto/worker-client';

export const ENCRYPTION_FORMAT_VERSION = 1;

/**
 * PBKDF2-HMAC-SHA256 work factor for newly-minted wrapped-key bundles. 600k is
 * the OWASP 2023 minimum. The count a bundle was wrapped under is stored on the
 * bundle (`passphraseIterations` / `recoveryIterations`) so unwrapping always
 * uses the right one — that's what lets us raise this without locking out keys
 * wrapped under the old value.
 */
export const PBKDF2_ITERATIONS = 600_000;

/**
 * Work factor used before iteration counts were stored on the bundle. Bundles
 * (local rows or server rows) that predate the `*_iterations` columns are
 * assumed to have been wrapped with this, so they still unwrap.
 */
export const LEGACY_PBKDF2_ITERATIONS = 210_000;

/**
 * PBKDF2 the passphrase + bundle's passphrase salt to derive the KEK that
 * wraps the DEK. The caller pulls the salt and iteration count out of the
 * wrapped-key bundle — there's no implicit lookup, so the dependency is
 * explicit at every call site.
 */
export async function derivePassphraseKek(
  passphrase: string,
  saltB64: string,
  iterations: number,
): Promise<string> {
  if (!passphrase) throw new Error('Passphrase is required.');
  const { keyB64 } = await cryptoWorker.call('derive-key', { passphrase, saltB64, iterations });
  return keyB64;
}

export async function encryptRecord(keyB64: string, record: unknown) {
  return cryptoWorker.call('encrypt', { keyB64, plaintext: JSON.stringify(record) });
}

export async function decryptRecord<T>(keyB64: string, ciphertext: string, iv: string): Promise<T> {
  const { plaintext } = await cryptoWorker.call('decrypt', { keyB64, ciphertext, iv });
  return JSON.parse(plaintext) as T;
}

/** Random 32-byte data encryption key, base64. The DEK encrypts every record;
 * KEKs (derived from passphrase or recovery code) only ever wrap this. */
export async function generateDek(): Promise<string> {
  const { dekB64 } = await cryptoWorker.call('generate-dek', {});
  return dekB64;
}

// Crockford-ish base32 alphabet: no 0/O, no 1/I, no U. 32 chars; 256 % 32 == 0
// so reducing a uniform byte mod 32 stays unbiased.
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTVWXYZ_';

/**
 * One high-entropy recovery code (~120 bits) presented as 6 dash-separated
 * groups of 4 characters. Singular by design: the user pastes the whole string
 * back in to recover, not individual segments.
 */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let raw = '';
  for (const b of bytes) raw += RECOVERY_ALPHABET[b & 31];
  return raw.match(/.{1,4}/g)!.join('-');
}

/** Strip whitespace and dashes; uppercase. Run before deriving so users can
 * paste the code with or without the formatting we displayed. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/** Random 16-byte salt, base64. Used as the recovery KEK salt; lives next to
 * the wrapped DEK on the server and in localStorage. */
export function generateSaltB64(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of salt) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** PBKDF2 the (normalized) recovery code with the recovery salt to get a KEK. */
export async function deriveRecoveryKek(code: string, saltB64: string, iterations: number): Promise<string> {
  const passphrase = normalizeRecoveryCode(code);
  if (!passphrase) throw new Error('Recovery code is empty.');
  const { keyB64 } = await cryptoWorker.call('derive-key', { passphrase, saltB64, iterations });
  return keyB64;
}

/** Encrypt the raw DEK bytes with the KEK. Returns the opaque blob stored on
 * the server and mirrored locally. */
export async function wrapDek(kekB64: string, dekB64: string) {
  return cryptoWorker.call('wrap-key', { kekB64, keyB64: dekB64 });
}

export async function unwrapDek(kekB64: string, ciphertext: string, iv: string): Promise<string> {
  const { keyB64 } = await cryptoWorker.call('unwrap-key', { kekB64, ciphertext, iv });
  return keyB64;
}

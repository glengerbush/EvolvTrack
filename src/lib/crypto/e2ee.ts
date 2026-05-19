import { cryptoWorker } from '$lib/crypto/worker-client';

export const ENCRYPTION_FORMAT_VERSION = 1;

/**
 * First-time setup: picks a per-user salt, persists it, and returns it.
 * The caller follows up with `deriveSessionKey` to get the AES key bytes for
 * the chosen passphrase.
 */
export async function initializePassphrase(passphrase: string) {
  const { saltB64 } = await cryptoWorker.call('derive', { passphrase });
  localStorage.setItem('et.salt', saltB64);
  return saltB64;
}

/**
 * Runs PBKDF2 on the passphrase + stored salt and returns the raw AES key
 * bytes (base64). This is the value held in the in-memory session cache and
 * optionally persisted to localStorage, so the user's passphrase string never
 * needs to live on disk in any form.
 */
export async function deriveSessionKey(passphrase: string): Promise<string> {
  const saltB64 = localStorage.getItem('et.salt');
  if (!saltB64) throw new Error('Missing key salt');
  const { keyB64 } = await cryptoWorker.call('derive-key', { passphrase, saltB64 });
  return keyB64;
}

export async function encryptRecord(keyB64: string, record: unknown) {
  return cryptoWorker.call('encrypt', { keyB64, plaintext: JSON.stringify(record) });
}

export async function decryptRecord<T>(keyB64: string, ciphertext: string, iv: string): Promise<T> {
  const { plaintext } = await cryptoWorker.call('decrypt', { keyB64, ciphertext, iv });
  return JSON.parse(plaintext) as T;
}

export function generateRecoveryCodes() {
  // Codes are ephemeral by design: they're shown once in a modal and then
  // dropped. Anything persistent would either rot (stale codes), invite
  // shoulder-surfing on a forgotten tab, or imply a guarantee we don't make.
  return Array.from({ length: 8 }, () => crypto.randomUUID().slice(0, 8).toUpperCase());
}

export function clearPassphraseMaterial() {
  localStorage.removeItem('et.salt');
  // Legacy: older builds persisted recovery codes here. Wipe on disable so
  // nothing lingers if someone upgrades through this code path.
  localStorage.removeItem('et.recovery.codes');
}

import { cryptoWorker } from '$lib/crypto/worker-client';

export const ENCRYPTION_FORMAT_VERSION = 1;

export async function initializePassphrase(passphrase: string) {
  const { saltB64 } = await cryptoWorker.call('derive', { passphrase });
  localStorage.setItem('et.salt', saltB64);
  return saltB64;
}

export async function encryptRecord(passphrase: string, record: unknown) {
  const saltB64 = localStorage.getItem('et.salt');
  if (!saltB64) throw new Error('Missing key salt');
  return cryptoWorker.call('encrypt', { passphrase, saltB64, plaintext: JSON.stringify(record) });
}

export async function decryptRecord<T>(passphrase: string, ciphertext: string, iv: string): Promise<T> {
  const saltB64 = localStorage.getItem('et.salt');
  if (!saltB64) throw new Error('Missing key salt');
  const { plaintext } = await cryptoWorker.call('decrypt', { passphrase, saltB64, ciphertext, iv });
  return JSON.parse(plaintext) as T;
}

export function generateRecoveryCodes() {
  const codes = Array.from({ length: 8 }, () => crypto.randomUUID().slice(0, 8).toUpperCase());
  localStorage.setItem('et.recovery.codes', JSON.stringify(codes));
  return codes;
}

export function clearPassphraseMaterial() {
  localStorage.removeItem('et.salt');
  localStorage.removeItem('et.recovery.codes');
}

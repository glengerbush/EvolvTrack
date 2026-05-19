// @vitest-environment happy-dom
//
// End-to-end check of the actual Web Crypto operations the worker performs:
// derive → export raw key → import raw key → encrypt → decrypt. If this round
// trip fails, the worker's crypto path is broken and we'd see
// "OperationError: The operation failed for an operation-specific reason"
// from a real sync cycle.
import { describe, expect, it } from 'vitest';

const te = new TextEncoder();
const td = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(v: string): Uint8Array {
  return Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

async function deriveAesKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const material = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function exportRawKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return toB64(new Uint8Array(raw));
}

async function importRawKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(fromB64(keyB64)),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

describe('worker crypto round trip', () => {
  it('derive → export → import → encrypt → decrypt produces the original plaintext', async () => {
    const passphrase = 'hunter2';
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = toB64(saltBytes);

    const derivedKey = await deriveAesKey(passphrase, saltB64);
    const keyB64 = await exportRawKey(derivedKey);
    expect(keyB64).toHaveLength(44); // 32 bytes → 44 chars b64 with one =

    // Encrypt with one imported view of the key.
    const encryptKey = await importRawKey(keyB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = JSON.stringify({ aggregate: 'weight', record: { weightLbs: 180 } });
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptKey,
      te.encode(plaintext),
    );
    const ciphertextB64 = toB64(new Uint8Array(cipher));
    const ivB64 = toB64(iv);

    // Decrypt with a *separately* imported view of the same key — this is what
    // the worker does, since each encrypt/decrypt message imports the key fresh
    // from the same keyB64 string.
    const decryptKey = await importRawKey(keyB64);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(fromB64(ivB64)) },
      decryptKey,
      toArrayBuffer(fromB64(ciphertextB64)),
    );

    expect(td.decode(decrypted)).toBe(plaintext);
  });

  it('decrypts with a key freshly derived from the same passphrase + salt', async () => {
    // Belt-and-suspenders: two independent derives from the same inputs must
    // produce the same key bytes, so a key derived in session A can decrypt
    // ciphertext produced in session B.
    const passphrase = 'hunter2';
    const saltB64 = toB64(crypto.getRandomValues(new Uint8Array(16)));

    const keyA = await deriveAesKey(passphrase, saltB64);
    const keyB = await deriveAesKey(passphrase, saltB64);

    const rawA = await exportRawKey(keyA);
    const rawB = await exportRawKey(keyB);
    expect(rawA).toBe(rawB);
  });
});

import type { WorkerRequest } from '$lib/crypto/worker-messages';

const te = new TextEncoder();
const td = new TextDecoder();

async function deriveKey(passphrase: string, saltB64: string) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const material = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

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

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'derive') {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltB64 = toB64(salt);
      await deriveKey(msg.payload.passphrase, saltB64);
      self.postMessage({ id: msg.id, ok: true, data: { saltB64 } });
      return;
    }

    if (msg.type === 'encrypt') {
      const { passphrase, saltB64, plaintext } = msg.payload;
      const key = await deriveKey(passphrase, saltB64);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext));
      self.postMessage({ id: msg.id, ok: true, data: { iv: toB64(iv), ciphertext: toB64(new Uint8Array(cipher)) } });
      return;
    }

    if (msg.type === 'decrypt') {
      const { passphrase, saltB64, ciphertext, iv } = msg.payload;
      const key = await deriveKey(passphrase, saltB64);
      const ivBytes = fromB64(iv);
      const cipherBytes = fromB64(ciphertext);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(ivBytes) },
        key,
        toArrayBuffer(cipherBytes)
      );
      self.postMessage({ id: msg.id, ok: true, data: { plaintext: td.decode(plain) } });
    }
  } catch (error) {
    self.postMessage({ id: msg.id, ok: false, error: (error as Error).message });
  }
};

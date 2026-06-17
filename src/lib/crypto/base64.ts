// Base64 <-> bytes helpers shared by the crypto worker and its tests, so the two
// can't drift. Kept dependency-free (just atob/btoa) so the worker bundle stays
// tiny and this module is usable from any context.

/**
 * Encode bytes as standard base64. Built in fixed-size chunks rather than
 * `btoa(String.fromCharCode(...bytes))`: spreading every byte as a function
 * argument overflows the call stack once the input is large (a long notes field
 * can push ciphertext past ~100KB), which would make that record's encrypt/sync
 * throw a RangeError. The chunked loop is O(n) with no argument-count limit.
 */
export function toB64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode standard base64 back into bytes. */
export function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

import { describe, expect, it } from 'vitest';
import { fromB64, toB64 } from './base64';

describe('base64 helpers', () => {
  it('round-trips small byte arrays', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  it('round-trips an empty array', () => {
    const bytes = new Uint8Array([]);
    expect(toB64(bytes)).toBe('');
    expect(fromB64('')).toEqual(bytes);
  });

  it('matches btoa for ASCII-range bytes', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(toB64(bytes)).toBe(btoa('hello world'));
  });

  it('encodes a large buffer without a stack overflow (regression: notes >100KB)', () => {
    // The old `btoa(String.fromCharCode(...bytes))` threw RangeError here.
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
    let encoded = '';
    expect(() => { encoded = toB64(big); }).not.toThrow();
    expect(fromB64(encoded)).toEqual(big);
  });
});

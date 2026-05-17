import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ callMock: vi.fn() }));
const callMock = h.callMock;

vi.mock('$lib/crypto/worker-client', () => ({
  cryptoWorker: {
    call: (...args: unknown[]) => h.callMock(...args),
  },
}));

import {
  ENCRYPTION_FORMAT_VERSION,
  clearPassphraseMaterial,
  decryptRecord,
  encryptRecord,
  generateRecoveryCodes,
  initializePassphrase,
} from './e2ee';

beforeEach(() => {
  localStorage.clear();
  callMock.mockReset();
});

describe('ENCRYPTION_FORMAT_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(ENCRYPTION_FORMAT_VERSION)).toBe(true);
    expect(ENCRYPTION_FORMAT_VERSION).toBeGreaterThan(0);
  });
});

describe('initializePassphrase', () => {
  it('asks the worker to derive a salt, stores it under et.salt, and returns it', async () => {
    callMock.mockResolvedValueOnce({ saltB64: 'SALT_AAA' });

    const result = await initializePassphrase('hunter2');

    expect(result).toBe('SALT_AAA');
    expect(localStorage.getItem('et.salt')).toBe('SALT_AAA');
    expect(callMock).toHaveBeenCalledWith('derive', { passphrase: 'hunter2' });
  });
});

describe('encryptRecord', () => {
  it('throws when no salt is present (passphrase not initialized)', async () => {
    await expect(encryptRecord('pw', { a: 1 })).rejects.toThrow(/missing key salt/i);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('serializes the record to JSON and forwards it with the salt to the worker', async () => {
    localStorage.setItem('et.salt', 'SALT_BBB');
    callMock.mockResolvedValueOnce({ ciphertext: 'CT', iv: 'IV' });

    const result = await encryptRecord('pw', { a: 1, b: 'two' });

    expect(result).toEqual({ ciphertext: 'CT', iv: 'IV' });
    expect(callMock).toHaveBeenCalledWith('encrypt', {
      passphrase: 'pw',
      saltB64: 'SALT_BBB',
      plaintext: JSON.stringify({ a: 1, b: 'two' }),
    });
  });
});

describe('decryptRecord', () => {
  it('throws when no salt is present', async () => {
    await expect(decryptRecord('pw', 'ct', 'iv')).rejects.toThrow(/missing key salt/i);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('forwards ciphertext/iv to the worker and JSON.parses the result', async () => {
    localStorage.setItem('et.salt', 'SALT_CCC');
    callMock.mockResolvedValueOnce({ plaintext: JSON.stringify({ hello: 'world' }) });

    const result = await decryptRecord<{ hello: string }>('pw', 'CT', 'IV');
    expect(result).toEqual({ hello: 'world' });
    expect(callMock).toHaveBeenCalledWith('decrypt', {
      passphrase: 'pw',
      saltB64: 'SALT_CCC',
      ciphertext: 'CT',
      iv: 'IV',
    });
  });

  it('propagates worker errors verbatim', async () => {
    localStorage.setItem('et.salt', 'SALT_D');
    callMock.mockRejectedValueOnce(new Error('bad-key'));
    await expect(decryptRecord('pw', 'CT', 'IV')).rejects.toThrow('bad-key');
  });
});

describe('generateRecoveryCodes', () => {
  it('produces 8 uppercase 8-char codes and persists them as JSON', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    for (const code of codes) {
      expect(code).toHaveLength(8);
      expect(code).toBe(code.toUpperCase());
      // First 8 chars of a v4 UUID: hex chars and a possible dash.
      expect(code).toMatch(/^[0-9A-F-]{8}$/);
    }
    expect(JSON.parse(localStorage.getItem('et.recovery.codes')!)).toEqual(codes);
  });

  it('returns a different set on each call (entropy from crypto.randomUUID)', () => {
    const a = generateRecoveryCodes();
    const b = generateRecoveryCodes();
    expect(a).not.toEqual(b);
  });
});

describe('clearPassphraseMaterial', () => {
  it('removes both the salt and the stored recovery codes', () => {
    localStorage.setItem('et.salt', 'x');
    localStorage.setItem('et.recovery.codes', '["a"]');
    localStorage.setItem('unrelated', 'keepme');

    clearPassphraseMaterial();

    expect(localStorage.getItem('et.salt')).toBeNull();
    expect(localStorage.getItem('et.recovery.codes')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keepme');
  });
});

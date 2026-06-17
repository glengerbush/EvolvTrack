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
  decryptRecord,
  derivePassphraseKek,
  deriveRecoveryKek,
  encryptRecord,
  generateDek,
  generateRecoveryCode,
  generateSaltB64,
  normalizeRecoveryCode,
  unwrapDek,
  wrapDek,
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

describe('derivePassphraseKek', () => {
  it('rejects an empty passphrase', async () => {
    await expect(derivePassphraseKek('', 'SALT', 600_000)).rejects.toThrow(/passphrase is required/i);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('forwards passphrase + salt + iterations to the worker and returns the KEK bytes', async () => {
    callMock.mockResolvedValueOnce({ keyB64: 'KEK_XYZ' });
    const result = await derivePassphraseKek('hunter2', 'SALT_XYZ', 600_000);
    expect(result).toBe('KEK_XYZ');
    expect(callMock).toHaveBeenCalledWith('derive-key', {
      passphrase: 'hunter2',
      saltB64: 'SALT_XYZ',
      iterations: 600_000,
    });
  });
});

describe('encryptRecord', () => {
  it('serializes the record to JSON and forwards it to the worker with the key', async () => {
    callMock.mockResolvedValueOnce({ ciphertext: 'CT', iv: 'IV' });

    const result = await encryptRecord('KEY_BBB', { a: 1, b: 'two' });

    expect(result).toEqual({ ciphertext: 'CT', iv: 'IV' });
    expect(callMock).toHaveBeenCalledWith('encrypt', {
      keyB64: 'KEY_BBB',
      plaintext: JSON.stringify({ a: 1, b: 'two' }),
    });
  });
});

describe('decryptRecord', () => {
  it('forwards ciphertext/iv to the worker with the key and JSON.parses the result', async () => {
    callMock.mockResolvedValueOnce({ plaintext: JSON.stringify({ hello: 'world' }) });

    const result = await decryptRecord<{ hello: string }>('KEY_CCC', 'CT', 'IV');
    expect(result).toEqual({ hello: 'world' });
    expect(callMock).toHaveBeenCalledWith('decrypt', {
      keyB64: 'KEY_CCC',
      ciphertext: 'CT',
      iv: 'IV',
    });
  });

  it('propagates worker errors verbatim', async () => {
    callMock.mockRejectedValueOnce(new Error('bad-key'));
    await expect(decryptRecord('KEY_D', 'CT', 'IV')).rejects.toThrow('bad-key');
  });
});

describe('generateDek', () => {
  it('asks the worker for a fresh DEK and returns it unchanged', async () => {
    callMock.mockResolvedValueOnce({ dekB64: 'DEK_AAA' });

    const result = await generateDek();

    expect(result).toBe('DEK_AAA');
    expect(callMock).toHaveBeenCalledWith('generate-dek', {});
  });
});

describe('generateRecoveryCode', () => {
  it('returns a 6×4 dash-grouped string drawn from the recovery alphabet', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[2-9A-HJ-NP-Z_]{4}(-[2-9A-HJ-NP-Z_]{4}){5}$/);
  });

  it('omits ambiguous characters (0, 1, I, O, U) entirely', () => {
    // 200 samples × 24 chars each → ~5000 chars; flake risk is statistically zero.
    const corpus = Array.from({ length: 200 }, () => generateRecoveryCode()).join('');
    for (const banned of ['0', '1', 'I', 'O', 'U']) {
      expect(corpus.includes(banned)).toBe(false);
    }
  });

  it('produces a different code every call', () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });
});

describe('normalizeRecoveryCode', () => {
  it('strips spaces and dashes and uppercases', () => {
    expect(normalizeRecoveryCode(' abcd-efgh xyzz-2345-6789-jkmn ')).toBe(
      'ABCDEFGHXYZZ23456789JKMN',
    );
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeRecoveryCode('   -- - ')).toBe('');
  });
});

describe('generateSaltB64', () => {
  it('returns 16 random bytes as base64 (24 chars with padding)', () => {
    const a = generateSaltB64();
    const b = generateSaltB64();
    expect(a).toHaveLength(24);
    expect(a).not.toBe(b);
  });
});

describe('deriveRecoveryKek', () => {
  it('normalizes the code before sending it to the worker', async () => {
    callMock.mockResolvedValueOnce({ keyB64: 'KEK_R' });

    const result = await deriveRecoveryKek(' abcd-efgh ', 'SALT_R', 600_000);

    expect(result).toBe('KEK_R');
    expect(callMock).toHaveBeenCalledWith('derive-key', {
      passphrase: 'ABCDEFGH',
      saltB64: 'SALT_R',
      iterations: 600_000,
    });
  });

  it('refuses an empty (post-normalization) code', async () => {
    await expect(deriveRecoveryKek('  --  ', 'SALT_R', 600_000)).rejects.toThrow(/empty/i);
    expect(callMock).not.toHaveBeenCalled();
  });
});

describe('wrapDek / unwrapDek', () => {
  it('wrap forwards the kek + raw DEK bytes to the worker', async () => {
    callMock.mockResolvedValueOnce({ ciphertext: 'CT', iv: 'IV' });

    const result = await wrapDek('KEK', 'DEK');

    expect(result).toEqual({ ciphertext: 'CT', iv: 'IV' });
    expect(callMock).toHaveBeenCalledWith('wrap-key', { kekB64: 'KEK', keyB64: 'DEK' });
  });

  it('unwrap forwards the kek + ciphertext and returns the DEK bytes', async () => {
    callMock.mockResolvedValueOnce({ keyB64: 'DEK_OUT' });

    const result = await unwrapDek('KEK', 'CT', 'IV');

    expect(result).toBe('DEK_OUT');
    expect(callMock).toHaveBeenCalledWith('unwrap-key', { kekB64: 'KEK', ciphertext: 'CT', iv: 'IV' });
  });
});

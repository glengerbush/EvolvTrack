import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import type { WrappedKeyBundle } from '$lib/domain/types';

const state = vi.hoisted(() => ({
  localBundle: undefined as WrappedKeyBundle | undefined,
  remoteBundle: undefined as WrappedKeyBundle | undefined,
  generatedCodeCounter: 0,
  saltCounter: 0,
  upsertRemoteShouldFail: false,
}));

vi.mock('$lib/crypto/e2ee', () => ({
  ENCRYPTION_FORMAT_VERSION: 1,
  PBKDF2_ITERATIONS: 600000,
  LEGACY_PBKDF2_ITERATIONS: 210000,
  generateRecoveryCode: vi.fn(() => {
    state.generatedCodeCounter += 1;
    return `CODE_${state.generatedCodeCounter}`;
  }),
  generateSaltB64: vi.fn(() => {
    state.saltCounter += 1;
    return `SALT_${state.saltCounter}`;
  }),
  derivePassphraseKek: vi.fn(async (passphrase: string, salt: string) => `KEK(${passphrase}|${salt})`),
  deriveRecoveryKek: vi.fn(async (code: string, salt: string) => `RKEK(${code}|${salt})`),
  wrapDek: vi.fn(async (kek: string, dek: string) => ({
    ciphertext: `wrap(${kek},${dek})`,
    iv: 'wiv',
  })),
  unwrapDek: vi.fn(async (kek: string, ciphertext: string) => {
    const match = ciphertext.match(/^wrap\(([^,]+),(.+)\)$/);
    if (!match || match[1] !== kek) throw new Error('OperationError');
    return match[2];
  }),
}));

vi.mock('$lib/sync/wrapped-keys', () => ({
  getLocalWrappedKeys: vi.fn(async () => state.localBundle),
  saveLocalWrappedKeys: vi.fn(async (bundle: Omit<WrappedKeyBundle, 'id'>) => {
    const row: WrappedKeyBundle = { id: 'self', ...bundle };
    state.localBundle = row;
    return row;
  }),
  upsertRemoteWrappedKeys: vi.fn(async (bundle: WrappedKeyBundle) => {
    if (state.upsertRemoteShouldFail) throw new Error('upload-failed');
    state.remoteBundle = bundle;
  }),
}));

import { rotateRecoveryCode } from './recovery-code-rotation';
import { generateRecoveryCode, generateSaltB64 } from '$lib/crypto/e2ee';
import { saveLocalWrappedKeys, upsertRemoteWrappedKeys } from '$lib/sync/wrapped-keys';

function existingBundle(): WrappedKeyBundle {
  return {
    id: 'self',
    dekVersion: 7,
    passphraseSaltB64: 'SALT_PW',
    passphraseWrapped: {
      ciphertext: 'wrap(KEK(pw|SALT_PW),DEK_BYTES)',
      iv: 'wiv',
    },
    // Legacy work factor: the passphrase half must survive a recovery-code
    // rotation untouched, while the fresh recovery half is minted at 600k.
    passphraseIterations: 210_000,
    recoverySaltB64: 'SALT_OLD',
    recoveryWrapped: {
      ciphertext: 'wrap(RKEK(OLD_CODE|SALT_OLD),DEK_BYTES)',
      iv: 'wiv',
    },
    recoveryIterations: 210_000,
    updatedAt: '2026-04-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  state.localBundle = existingBundle();
  state.remoteBundle = state.localBundle;
  state.generatedCodeCounter = 0;
  state.saltCounter = 0;
  state.upsertRemoteShouldFail = false;
  vi.mocked(generateRecoveryCode).mockClear();
  vi.mocked(generateSaltB64).mockClear();
  vi.mocked(saveLocalWrappedKeys).mockClear();
  vi.mocked(upsertRemoteWrappedKeys).mockClear();
});

describe('rotateRecoveryCode — argument validation', () => {
  it('requires a passphrase', async () => {
    await expect(rotateRecoveryCode('')).rejects.toThrow(/current passphrase is required/i);
  });

  it('rejects when no bundle exists locally', async () => {
    state.localBundle = undefined;
    await expect(rotateRecoveryCode('pw')).rejects.toThrow(/no wrapped-key bundle/i);
  });

  it('rejects an incorrect passphrase without touching the bundle', async () => {
    await expect(rotateRecoveryCode('WRONG')).rejects.toThrow(/OperationError/);
    // Bundle unchanged.
    expect(state.localBundle?.recoveryWrapped.ciphertext).toBe(
      'wrap(RKEK(OLD_CODE|SALT_OLD),DEK_BYTES)',
    );
    expect(generateRecoveryCode).not.toHaveBeenCalled();
  });
});

describe('rotateRecoveryCode — happy path', () => {
  it('returns a fresh recovery code, leaves dekVersion unchanged', async () => {
    const result = await rotateRecoveryCode('pw');

    expect(result.recoveryCode).toBe('CODE_1');
    expect(result.dekVersion).toBe(7); // unchanged
  });

  it('rewraps the DEK with a fresh recovery salt + KEK and keeps the passphrase wrap intact', async () => {
    await rotateRecoveryCode('pw');

    expect(state.localBundle?.passphraseWrapped.ciphertext).toBe(
      'wrap(KEK(pw|SALT_PW),DEK_BYTES)',
    );
    expect(state.localBundle?.recoverySaltB64).toBe('SALT_1');
    expect(state.localBundle?.recoveryWrapped.ciphertext).toBe(
      'wrap(RKEK(CODE_1|SALT_1),DEK_BYTES)',
    );
  });

  it('raises the recovery half to the new work factor but preserves the passphrase half', async () => {
    // The existing bundle is at the legacy 210k; only the recovery half is
    // re-minted here, so it moves to 600k while the passphrase half stays put.
    await rotateRecoveryCode('pw');
    expect(state.localBundle?.recoveryIterations).toBe(600000);
    expect(state.localBundle?.passphraseIterations).toBe(210000);
  });

  it('uploads to the server before saving locally so a remote failure leaves local untouched', async () => {
    const order: string[] = [];
    vi.mocked(upsertRemoteWrappedKeys).mockImplementationOnce(async (bundle) => {
      order.push('remote');
      state.remoteBundle = bundle;
    });
    vi.mocked(saveLocalWrappedKeys).mockImplementationOnce(async (bundle) => {
      order.push('local');
      const row: WrappedKeyBundle = { id: 'self', ...bundle };
      state.localBundle = row;
      return row;
    });

    await rotateRecoveryCode('pw');

    expect(order).toEqual(['remote', 'local']);
  });

  it('leaves the local bundle untouched when the remote upload fails', async () => {
    state.upsertRemoteShouldFail = true;
    const before = state.localBundle?.recoveryWrapped.ciphertext;

    await expect(rotateRecoveryCode('pw')).rejects.toThrow('upload-failed');

    expect(state.localBundle?.recoveryWrapped.ciphertext).toBe(before);
    expect(saveLocalWrappedKeys).not.toHaveBeenCalled();
  });
});

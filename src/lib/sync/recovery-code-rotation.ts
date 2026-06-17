/**
 * Issue a fresh recovery code without rotating the DEK.
 *
 * Useful when only the recovery code is presumed compromised — written down
 * somewhere and possibly seen, password manager exposed, etc. Distinct from
 * full key rotation: no records are re-encrypted, no migration state, the
 * passphrase wrap is preserved untouched. Forward secrecy of the data
 * itself is not improved; only the recovery escape hatch is rolled.
 *
 * For "I think my device was compromised" the user should run
 * `startE2EEKeyRotation` instead — that gives forward secrecy.
 */
import type { WrappedKeyBundle } from '$lib/domain/types';
import {
  PBKDF2_ITERATIONS,
  derivePassphraseKek,
  deriveRecoveryKek,
  generateRecoveryCode,
  generateSaltB64,
  unwrapDek,
  wrapDek,
} from '$lib/crypto/e2ee';
import {
  getLocalWrappedKeys,
  saveLocalWrappedKeys,
  upsertRemoteWrappedKeys,
} from '$lib/sync/wrapped-keys';

export type RecoveryCodeRotationResult = {
  recoveryCode: string;
  dekVersion: number;
};

export async function rotateRecoveryCode(currentPassphrase: string): Promise<RecoveryCodeRotationResult> {
  if (!currentPassphrase) throw new Error('Current passphrase is required.');

  const existing = await getLocalWrappedKeys();
  if (!existing) {
    throw new Error('No wrapped-key bundle is present locally. Enable E2EE first.');
  }

  // Unwrap the DEK with the current passphrase — proof of possession AND the
  // value we'll rewrap under the new recovery KEK.
  const passphraseKek = await derivePassphraseKek(
    currentPassphrase,
    existing.passphraseSaltB64,
    existing.passphraseIterations,
  );
  const dek = await unwrapDek(
    passphraseKek,
    existing.passphraseWrapped.ciphertext,
    existing.passphraseWrapped.iv,
  );

  const recoveryCode = generateRecoveryCode();
  const recoverySaltB64 = generateSaltB64();
  // The fresh recovery KEK uses the current (raised) work factor; the passphrase
  // half is left untouched, so its own iteration count is preserved.
  const recoveryKek = await deriveRecoveryKek(recoveryCode, recoverySaltB64, PBKDF2_ITERATIONS);
  const recoveryWrapped = await wrapDek(recoveryKek, dek);

  const updated: WrappedKeyBundle = {
    ...existing,
    recoverySaltB64,
    recoveryWrapped,
    recoveryIterations: PBKDF2_ITERATIONS,
    updatedAt: new Date().toISOString(),
  };

  // Push to the server first. If the upload fails the local copy stays
  // untouched, so the user keeps their working old recovery code rather than
  // a code that only works on this device.
  await upsertRemoteWrappedKeys(updated);
  await saveLocalWrappedKeys(updated);

  return { recoveryCode, dekVersion: updated.dekVersion };
}

import { describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import {
  addEntry,
  addPrescription,
  clearAllData,
  hasPlainHealthData,
  observeProfile,
  saveProfile,
} from './health-data-storage';
import { iso } from '../../test/iso';

describe('Health Data Storage observation', () => {
  it('publishes persisted profile changes', async () => {
    const profiles: Array<{ weightUnit?: string } | undefined> = [];
    const unsubscribe = observeProfile((profile) => profiles.push(profile));

    try {
      await saveProfile({ weightUnit: 'kg' });

      await vi.waitFor(() => {
        expect(profiles.at(-1)?.weightUnit).toBe('kg');
      });
    } finally {
      unsubscribe();
    }
  });

  it('detects a readable Health Entry or Vial', async () => {
    await expect(hasPlainHealthData()).resolves.toBe(false);

    await addEntry({ date: iso('2026-05-10'), weightLbs: 180 });
    await expect(hasPlainHealthData()).resolves.toBe(true);

    await clearAllData();
    await addPrescription({ type: 'Semaglutide (Ozempic / Wegovy)' });
    await expect(hasPlainHealthData()).resolves.toBe(true);
  });
});

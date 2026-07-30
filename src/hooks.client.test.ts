// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  deleteDatabase: vi.fn(),
  openDatabase: vi.fn(),
}));
const wipeKey = 'evolvtrack:wipe-db-on-boot';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/db/schema', () => ({
  db: {
    delete: (...args: unknown[]) => h.deleteDatabase(...args),
    open: (...args: unknown[]) => h.openDatabase(...args),
  },
}));
vi.mock('$lib/auth/supabase', () => ({
  WIPE_DB_ON_BOOT_KEY: 'evolvtrack:wipe-db-on-boot',
}));

import { init } from './hooks.client';

beforeEach(() => {
  localStorage.clear();
  h.deleteDatabase.mockReset().mockResolvedValue(undefined);
  h.openDatabase.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('client boot database wipe', () => {
  it('does nothing when logout did not request a wipe', async () => {
    await init();

    expect(h.deleteDatabase).not.toHaveBeenCalled();
    expect(h.openDatabase).not.toHaveBeenCalled();
  });

  it('deletes and reopens the database before clearing the retry sentinel', async () => {
    localStorage.setItem(wipeKey, '1');

    await init();

    expect(h.deleteDatabase).toHaveBeenCalledOnce();
    expect(h.openDatabase).toHaveBeenCalledOnce();
    expect(localStorage.getItem(wipeKey)).toBeNull();
  });

  it('keeps the sentinel when deleting the database fails', async () => {
    localStorage.setItem(wipeKey, '1');
    h.deleteDatabase.mockRejectedValueOnce(new Error('blocked by another tab'));

    await expect(init()).resolves.toBeUndefined();

    expect(h.openDatabase).not.toHaveBeenCalled();
    expect(localStorage.getItem(wipeKey)).toBe('1');
  });

  it('keeps the sentinel when reopening the empty database fails', async () => {
    localStorage.setItem(wipeKey, '1');
    h.openDatabase.mockRejectedValueOnce(new Error('open failed'));

    await expect(init()).resolves.toBeUndefined();

    expect(h.deleteDatabase).toHaveBeenCalledOnce();
    expect(localStorage.getItem(wipeKey)).toBe('1');
  });
});

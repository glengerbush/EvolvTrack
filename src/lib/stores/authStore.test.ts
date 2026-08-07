// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const h = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return {
    getSessionImpl: () => Promise.resolve({ data: { session: null } }) as Promise<{
      data: { session: { user: unknown } | null };
    }>,
    unsubscribe,
    onAuthStateChange: vi.fn((_callback: unknown) => ({ data: { subscription: { unsubscribe } } })),
  };
});

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => h.getSessionImpl(),
      onAuthStateChange: (callback: unknown) => h.onAuthStateChange(callback),
    },
  },
}));

beforeEach(() => {
  h.getSessionImpl = () => Promise.resolve({ data: { session: null } });
  h.onAuthStateChange.mockClear();
  h.unsubscribe.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('authState', () => {
  it('settles as signed out when restoring the persisted session fails', async () => {
    const failure = new Error('IndexedDB unavailable');
    h.getSessionImpl = () => Promise.reject(failure);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { awaitSettledAuth } = await import('./authStore');

    await expect(awaitSettledAuth()).resolves.toEqual({ kind: 'signed-out' });
    expect(console.error).toHaveBeenCalledWith(
      'Failed to restore the authentication session:',
      failure,
    );
  });

  it('settles with the restored signed-in user', async () => {
    const user = { id: 'user-1' };
    h.getSessionImpl = () => Promise.resolve({ data: { session: { user } } });

    const { awaitSettledAuth } = await import('./authStore');

    await expect(awaitSettledAuth()).resolves.toEqual({ kind: 'signed-in', user });
  });

  it('immediately revokes a signed-in identity for Device Data Erasure', async () => {
    const user = { id: 'user-1' };
    h.getSessionImpl = () => Promise.resolve({ data: { session: { user } } });
    const { authState, awaitSettledAuth, revokeAuthStateForDeviceDataErasure } =
      await import('./authStore');
    const unsubscribe = authState.subscribe(() => undefined);
    await awaitSettledAuth();

    revokeAuthStateForDeviceDataErasure();

    expect(get(authState)).toEqual({ kind: 'signed-out' });
    unsubscribe();
  });
});

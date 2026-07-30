// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return {
    getSessionImpl: () => Promise.resolve({ data: { session: null } }) as Promise<{
      data: { session: { user: unknown } | null };
    }>,
    unsubscribe,
    onAuthStateChange: vi.fn((_event: unknown, _session: unknown) => ({
      data: { subscription: { unsubscribe } },
    })),
  };
});

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => h.getSessionImpl(),
      onAuthStateChange: (event: unknown, session: unknown) =>
        h.onAuthStateChange(event, session),
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
});

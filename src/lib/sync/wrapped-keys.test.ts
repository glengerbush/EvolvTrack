import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WrappedKeyBundle } from '$lib/domain/types';

const h = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock('$lib/auth/supabase', () => ({
  supabase: {
    auth: { getUser: (...a: unknown[]) => h.getUserMock(...a) },
    from: (...a: unknown[]) => h.fromMock(...a),
  },
}));

// The local-cache half isn't under test here; stub the Dexie table.
vi.mock('$lib/db/schema', () => ({
  db: { wrappedKeys: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

import {
  deleteRemoteWrappedKeys,
  fetchAllRemoteWrappedKeys,
  fetchRemoteWrappedKeys,
  upsertRemoteWrappedKeys,
} from './wrapped-keys';

type QueryCalls = {
  eqs: Array<[string, unknown]>;
  order: [string, unknown] | null;
  limit: number | null;
  op: 'upsert' | 'delete' | null;
  payload: Record<string, unknown> | null;
  onConflict: string | undefined;
};

function makeBuilder(result: { data: unknown; error: unknown }) {
  const calls: QueryCalls = { eqs: [], order: null, limit: null, op: null, payload: null, onConflict: undefined };
  const builder: { calls: QueryCalls } & Record<string, unknown> = {
    calls,
    select: vi.fn(() => builder),
    eq: vi.fn((col: string, val: unknown) => {
      calls.eqs.push([col, val]);
      return builder;
    }),
    order: vi.fn((col: string, opts: unknown) => {
      calls.order = [col, opts];
      return builder;
    }),
    limit: vi.fn((n: number) => {
      calls.limit = n;
      return builder;
    }),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    upsert: vi.fn((payload: Record<string, unknown>, opts: { onConflict?: string }) => {
      calls.op = 'upsert';
      calls.payload = payload;
      calls.onConflict = opts?.onConflict;
      return Promise.resolve(result);
    }),
    delete: vi.fn(() => {
      calls.op = 'delete';
      return builder;
    }),
    // Thenable so `await query` (fetchAll, delete) resolves to the result.
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return builder;
}

let builder: ReturnType<typeof makeBuilder>;

function setResult(data: unknown, error: unknown = null) {
  builder = makeBuilder({ data, error });
  h.fromMock.mockImplementation(() => builder);
}

function row(dekVersion: number) {
  return {
    dek_version: dekVersion,
    passphrase_salt_b64: 'ps',
    passphrase_wrapped_ciphertext: 'pc',
    passphrase_wrapped_iv: 'pi',
    recovery_salt_b64: 'rs',
    recovery_wrapped_ciphertext: 'rc',
    recovery_wrapped_iv: 'ri',
    updated_at: '2026-06-03T00:00:00.000Z',
  };
}

beforeEach(() => {
  h.getUserMock.mockReset();
  h.fromMock.mockReset();
  h.getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
});

describe('fetchRemoteWrappedKeys', () => {
  it('with a version, filters by that exact dek_version', async () => {
    setResult(row(2));
    const bundle = await fetchRemoteWrappedKeys(2);
    expect(builder.calls.eqs).toContainEqual(['dek_version', 2]);
    expect(bundle?.dekVersion).toBe(2);
  });

  it('without a version, returns the newest bundle (order desc, limit 1)', async () => {
    setResult(row(3));
    const bundle = await fetchRemoteWrappedKeys();
    expect(builder.calls.order).toEqual(['dek_version', { ascending: false }]);
    expect(builder.calls.limit).toBe(1);
    expect(builder.calls.eqs).not.toContainEqual(['dek_version', expect.anything()]);
    expect(bundle?.dekVersion).toBe(3);
  });

  it('returns null when there is no bundle', async () => {
    setResult(null);
    expect(await fetchRemoteWrappedKeys()).toBeNull();
  });
});

describe('fetchAllRemoteWrappedKeys', () => {
  it('maps every bundle for the user', async () => {
    setResult([row(1), row(2)]);
    const bundles = await fetchAllRemoteWrappedKeys();
    expect(bundles.map((b) => b.dekVersion)).toEqual([1, 2]);
  });
});

describe('upsertRemoteWrappedKeys', () => {
  it('upserts on (user_id, dek_version) so a new version is added, not clobbered', async () => {
    setResult(null);
    const bundle: WrappedKeyBundle = {
      id: 'self',
      dekVersion: 2,
      passphraseSaltB64: 'ps',
      passphraseWrapped: { ciphertext: 'pc', iv: 'pi' },
      recoverySaltB64: 'rs',
      recoveryWrapped: { ciphertext: 'rc', iv: 'ri' },
      updatedAt: '2026-06-03T00:00:00.000Z',
    };
    await upsertRemoteWrappedKeys(bundle);
    expect(builder.calls.onConflict).toBe('user_id,dek_version');
    expect(builder.calls.payload).toMatchObject({ user_id: 'user-1', dek_version: 2 });
  });
});

describe('deleteRemoteWrappedKeys', () => {
  it('without a version, deletes every bundle for the user', async () => {
    setResult(null);
    await deleteRemoteWrappedKeys();
    expect(builder.calls.op).toBe('delete');
    expect(builder.calls.eqs).toEqual([['user_id', 'user-1']]);
  });

  it('with a version, deletes only that version', async () => {
    setResult(null);
    await deleteRemoteWrappedKeys(1);
    expect(builder.calls.eqs).toContainEqual(['dek_version', 1]);
  });
});

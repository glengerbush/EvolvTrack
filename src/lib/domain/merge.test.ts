import { describe, expect, it } from 'vitest';
import {
  applyPatchWithClears,
  bumpFieldStamps,
  mergeRecord,
  stampAllFields,
  type Mergeable,
} from './merge';

const T0 = '2026-05-09T00:00:00.000Z';
const T1 = '2026-05-10T00:00:00.000Z';
const T2 = '2026-05-11T00:00:00.000Z';

type Row = Mergeable & {
  weightLbs?: number;
  wellness?: number;
  symptoms?: string[];
};

function row(updatedAt: string, fields: Omit<Row, 'id' | 'createdAt' | 'updatedAt'> = {}): Row {
  return { id: 'r1', createdAt: T0, updatedAt, ...fields };
}

describe('mergeRecord', () => {
  it('takes each side\'s value for the field whose clock is later', () => {
    const local = stampAllFields(row(T1, { weightLbs: 180, wellness: 6 }), T1);
    // Remote was created at T1 like ours, then re-stamped only `weightLbs` at T2.
    const remote = stampAllFields(row(T1, { weightLbs: 175, wellness: 6 }), T1);
    remote.fieldUpdatedAt!.weightLbs = T2;
    remote.updatedAt = T2;

    const { merged, localHasNews, remoteHasNews } = mergeRecord(local, remote);

    expect(merged.weightLbs).toBe(175);    // remote: T2 > T1
    expect(merged.wellness).toBe(6);       // tie at T1, local wins
    expect(merged.fieldUpdatedAt).toMatchObject({ weightLbs: T2, wellness: T1 });
    expect(merged.updatedAt).toBe(T2);     // max of stamps
    expect(remoteHasNews).toBe(true);
    expect(localHasNews).toBe(false);
  });

  it('preserves both edits when two devices touch different fields', () => {
    // The bug this whole change is for. Initial state at T0 on both sides.
    // Device A bumps symptoms at T1; device B bumps wellness at T2.
    const local = stampAllFields(row(T0, { wellness: 5, symptoms: ['a'] }), T0);
    local.symptoms = ['a', 'b'];
    Object.assign(local, bumpFieldStamps(local, ['symptoms'], T1));

    const remote = stampAllFields(row(T0, { wellness: 5, symptoms: ['a'] }), T0);
    remote.wellness = 7;
    Object.assign(remote, bumpFieldStamps(remote, ['wellness'], T2));

    const { merged, localHasNews, remoteHasNews } = mergeRecord(local, remote);

    expect(merged.symptoms).toEqual(['a', 'b']);  // local's edit survives
    expect(merged.wellness).toBe(7);              // remote's edit survives
    expect(localHasNews).toBe(true);
    expect(remoteHasNews).toBe(true);
    // updatedAt is the max across all stamps so the outbox/cursor still works.
    expect(merged.updatedAt).toBe(T2);
  });

  it('falls back to row updatedAt for fields with no per-field stamp (legacy records)', () => {
    // Records written before the per-field clock existed — every field's
    // effective clock is the row updatedAt.
    const local: Row = { id: 'r1', createdAt: T0, updatedAt: T2, weightLbs: 180, wellness: 6 };
    const remote: Row = { id: 'r1', createdAt: T0, updatedAt: T1, weightLbs: 175, wellness: 7 };

    const { merged, localHasNews, remoteHasNews } = mergeRecord(local, remote);

    expect(merged.weightLbs).toBe(180);  // local newer
    expect(merged.wellness).toBe(6);     // local newer
    expect(localHasNews).toBe(true);
    expect(remoteHasNews).toBe(false);
  });

  it('mixed: local has per-field stamps, remote is legacy (and vice versa)', () => {
    // Local edited wellness at T2 explicitly; remote is a legacy snapshot at
    // T1 with no per-field clock — every remote field is treated as T1.
    const local = stampAllFields(row(T0, { weightLbs: 180, wellness: 5 }), T0);
    local.wellness = 9;
    Object.assign(local, bumpFieldStamps(local, ['wellness'], T2));

    const remote: Row = {
      id: 'r1',
      createdAt: T0,
      updatedAt: T1,
      weightLbs: 175,
      wellness: 6,
    };

    const { merged } = mergeRecord(local, remote);

    expect(merged.weightLbs).toBe(175);  // remote T1 > local field stamp T0
    expect(merged.wellness).toBe(9);     // local T2 > remote T1
  });

  it('ties resolve to local (matches the strict-greater rule in legacy LWW)', () => {
    const local = stampAllFields(row(T1, { weightLbs: 180 }), T1);
    const remote = stampAllFields(row(T1, { weightLbs: 175 }), T1);
    const { merged, localHasNews, remoteHasNews } = mergeRecord(local, remote);

    expect(merged.weightLbs).toBe(180);
    // A tie is a no-op: neither side has news over the other.
    expect(localHasNews).toBe(false);
    expect(remoteHasNews).toBe(false);
  });

  it('never mutates id or createdAt — always taken from local', () => {
    const local = stampAllFields(row(T1, { weightLbs: 180 }), T1);
    const remote: Row = {
      id: 'r1',
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: T2,
      weightLbs: 175,
    };

    const { merged } = mergeRecord(local, remote);
    expect(merged.id).toBe('r1');
    expect(merged.createdAt).toBe(T0);
  });
});

describe('stampAllFields', () => {
  it('stamps every persistent field with the given timestamp', () => {
    const stamped = stampAllFields(
      { id: 'r1', createdAt: T0, updatedAt: T0, weightLbs: 180, symptoms: ['a'] } as Row,
      T1,
    );
    expect(stamped.fieldUpdatedAt).toEqual({ weightLbs: T1, symptoms: T1 });
    expect(stamped.updatedAt).toBe(T1);
  });

  it('does not stamp reserved keys', () => {
    const stamped = stampAllFields(row(T0, { weightLbs: 180 }), T1);
    // Reserved: id, createdAt, updatedAt, fieldUpdatedAt — none should appear
    // as keys in fieldUpdatedAt.
    expect(Object.keys(stamped.fieldUpdatedAt!)).toEqual(['weightLbs']);
  });
});

describe('applyPatchWithClears', () => {
  it('sets non-undefined values and deletes keys whose patch value is undefined', () => {
    const base = { id: 'r1', a: 1, b: 2, c: 3 };
    const out = applyPatchWithClears(base, { b: 20, c: undefined });
    expect(out).toEqual({ id: 'r1', a: 1, b: 20 });
    expect('c' in out).toBe(false);
  });

  it('does not mutate the base', () => {
    const base = { id: 'r1', a: 1, b: 2 };
    applyPatchWithClears(base, { b: undefined });
    expect(base).toEqual({ id: 'r1', a: 1, b: 2 });
  });

  it('is a no-op for a patch that omits a key (vs. setting it to undefined)', () => {
    // Setting a key to undefined clears it; not mentioning the key leaves it
    // alone. The distinction is what makes "clear me" different from
    // "leave me alone" in the update API.
    const base = { id: 'r1', a: 1, b: 2 };
    expect(applyPatchWithClears(base, { a: 9 })).toEqual({ id: 'r1', a: 9, b: 2 });
  });
});

describe('reserved fields', () => {
  type ProfileLike = Mergeable & {
    startWeight?: number;     // syncable
    passphraseEnabled?: boolean; // device-local — never merged
    syncMode?: string;        // device-local — never merged
  };

  const RESERVED = new Set<string>(['passphraseEnabled', 'syncMode']);

  function profileRow(updatedAt: string, fields: Partial<ProfileLike>): ProfileLike {
    return { id: 'profile', createdAt: T0, updatedAt, ...fields };
  }

  it('mergeRecord never overwrites a reserved field with the remote value', () => {
    const local = stampAllFields(
      profileRow(T0, { startWeight: 200, passphraseEnabled: true, syncMode: 'e2ee' }),
      T0,
      { reserved: RESERVED },
    );
    // Remote, freshly pulled, "claims" to have different device-local values
    // (in practice the sender strips them, but defense-in-depth).
    const remote = stampAllFields(
      profileRow(T2, { startWeight: 180, passphraseEnabled: false, syncMode: 'plain' as never }),
      T2,
      { reserved: RESERVED },
    );

    const { merged } = mergeRecord(local, remote, { reserved: RESERVED });

    expect(merged.startWeight).toBe(180);          // syncable: remote newer
    expect(merged.passphraseEnabled).toBe(true);   // reserved: local preserved
    expect(merged.syncMode).toBe('e2ee');          // reserved: local preserved
    // Reserved fields don't appear in the field clock map.
    expect(Object.keys(merged.fieldUpdatedAt!)).not.toContain('passphraseEnabled');
    expect(Object.keys(merged.fieldUpdatedAt!)).not.toContain('syncMode');
  });

  it('stampAllFields skips reserved keys and strips any pre-existing stamps for them', () => {
    const stamped = stampAllFields(
      profileRow(T0, {
        startWeight: 200,
        passphraseEnabled: true,
        // Pre-existing stamp for a reserved field — should be dropped to keep
        // the cloud from ever seeing a clock for a local-only field.
        fieldUpdatedAt: { startWeight: T0, passphraseEnabled: T0 },
      }),
      T1,
      { reserved: RESERVED },
    );
    expect(Object.keys(stamped.fieldUpdatedAt!)).toEqual(['startWeight']);
  });

  it('bumpFieldStamps ignores attempts to bump a reserved field', () => {
    const before = stampAllFields(
      profileRow(T0, { startWeight: 200, passphraseEnabled: true }),
      T0,
      { reserved: RESERVED },
    );
    // Caller asks to bump both — only the syncable one actually moves.
    const next = bumpFieldStamps(before, ['startWeight', 'passphraseEnabled'], T1, {
      reserved: RESERVED,
    });
    expect(next.fieldUpdatedAt.startWeight).toBe(T1);
    expect(next.fieldUpdatedAt).not.toHaveProperty('passphraseEnabled');
  });
});

describe('bumpFieldStamps', () => {
  it('updates only the patched fields and carries the rest forward', () => {
    const before = stampAllFields(row(T0, { weightLbs: 180, wellness: 6 }), T0);
    const next = bumpFieldStamps(before, ['wellness'], T1);

    expect(next.fieldUpdatedAt).toMatchObject({
      weightLbs: T0, // unchanged
      wellness: T1,  // bumped
    });
    expect(next.updatedAt).toBe(T1);
  });

  it('baselines unstamped fields against the pre-edit row time (legacy bootstrap)', () => {
    // A row that predates per-field LWW: every field falls back to row time.
    // First edit through bumpFieldStamps should freeze those stamps at T0 so
    // a subsequent edit doesn't make them appear "newer".
    const legacy: Row = { id: 'r1', createdAt: T0, updatedAt: T0, weightLbs: 180, wellness: 6 };
    const next = bumpFieldStamps(legacy, ['wellness'], T1);

    expect(next.fieldUpdatedAt).toEqual({ weightLbs: T0, wellness: T1 });
  });
});

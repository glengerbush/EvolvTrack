import { describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { db } from '$lib/db/schema';
import {
  addWeight,
  applyRemoteChange,
  onHealthDataChange,
  updateInjection,
  updateWeight,
  type HealthDataChange,
} from '$lib/domain/repo';
import { stampAllFields } from '$lib/domain/merge';
import type { InjectionEntry, ProfileSettings, WeightEntry } from '$lib/domain/types';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const OLD = '2026-05-09T00:00:00.000Z';
const MID = '2026-05-10T00:00:00.000Z';
const NEW = '2026-05-11T00:00:00.000Z';

function weight(id: string, updatedAt: string, weightLbs = 180): WeightEntry {
  return {
    id,
    date: iso('2026-05-10'),
    weightLbs,
    symptoms: [],
    createdAt: MID,
    updatedAt,
  };
}

function injection(id: string, updatedAt: string, amountMg = 5): InjectionEntry {
  return {
    id,
    date: iso('2026-05-10'),
    amountMg,
    medication: SEMA,
    site: '',
    symptoms: [],
    createdAt: MID,
    updatedAt,
  };
}

function captureChanges() {
  const events: HealthDataChange[] = [];
  const unsubscribe = onHealthDataChange((c) => events.push(c));
  return { events, unsubscribe };
}

describe('applyRemoteChange — weight upserts', () => {
  it('inserts a brand-new entity and emits an add', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      const applied = await applyRemoteChange({
        aggregate: 'weight',
        entityId: 'w1',
        op: 'upsert',
        record: weight('w1', NEW),
        remoteUpdatedAt: NEW,
      });

      expect(applied).toBe(true);
      expect(await db.weights.get('w1')).toMatchObject({ id: 'w1', weightLbs: 180 });
      expect(events).toEqual([{ kind: 'weight', action: 'add', entity: weight('w1', NEW) }]);
    } finally {
      unsubscribe();
    }
  });

  it('overwrites a local row when the remote edit is newer', async () => {
    await db.weights.put(weight('w1', MID, 180));
    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'upsert',
      record: weight('w1', NEW, 175),
      remoteUpdatedAt: NEW,
    });

    expect(applied).toBe(true);
    expect((await db.weights.get('w1'))!.weightLbs).toBe(175);
  });

  it('keeps the local row when the local edit is newer (LWW)', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      await db.weights.put(weight('w1', NEW, 175));
      const applied = await applyRemoteChange({
        aggregate: 'weight',
        entityId: 'w1',
        op: 'upsert',
        record: weight('w1', OLD, 180),
        remoteUpdatedAt: OLD,
      });

      expect(applied).toBe(false);
      expect((await db.weights.get('w1'))!.weightLbs).toBe(175);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('is idempotent — re-applying the same upsert is a no-op the second time', async () => {
    const change = {
      aggregate: 'weight' as const,
      entityId: 'w1',
      op: 'upsert' as const,
      record: weight('w1', NEW),
      remoteUpdatedAt: NEW,
    };
    expect(await applyRemoteChange(change)).toBe(true);
    expect(await applyRemoteChange(change)).toBe(false);
  });
});

describe('applyRemoteChange — weight deletes', () => {
  it('removes a local row when the delete is newer and emits a delete', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      await db.weights.put(weight('w1', MID));
      const applied = await applyRemoteChange({
        aggregate: 'weight',
        entityId: 'w1',
        op: 'delete',
        record: null,
        remoteUpdatedAt: NEW,
      });

      expect(applied).toBe(true);
      expect(await db.weights.get('w1')).toBeUndefined();
      expect(events).toEqual([{ kind: 'weight', action: 'delete', id: 'w1' }]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps the row when a newer local edit beats the remote delete', async () => {
    await db.weights.put(weight('w1', NEW));
    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'delete',
      record: null,
      remoteUpdatedAt: OLD,
    });

    expect(applied).toBe(false);
    expect(await db.weights.get('w1')).toBeDefined();
  });

  it('is a no-op when the entity is already gone', async () => {
    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'ghost',
      op: 'delete',
      record: null,
      remoteUpdatedAt: NEW,
    });
    expect(applied).toBe(false);
  });
});

describe('applyRemoteChange — injections', () => {
  it('applies an upsert and emits an injection add', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      const applied = await applyRemoteChange({
        aggregate: 'injection',
        entityId: 'i1',
        op: 'upsert',
        record: injection('i1', NEW, 7),
        remoteUpdatedAt: NEW,
      });

      expect(applied).toBe(true);
      expect((await db.injections.get('i1'))!.amountMg).toBe(7);
      expect(events).toEqual([
        { kind: 'injection', action: 'add', entity: injection('i1', NEW, 7) },
      ]);
    } finally {
      unsubscribe();
    }
  });
});

describe('applyRemoteChange — prescriptions', () => {
  it('applies an upsert without emitting a health change (liveQuery observes the table)', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      const record = {
        id: 'p1',
        type: SEMA,
        dosesLeft: 4,
        createdAt: MID,
        updatedAt: NEW,
      };
      const applied = await applyRemoteChange({
        aggregate: 'prescription',
        entityId: 'p1',
        op: 'upsert',
        record,
        remoteUpdatedAt: NEW,
      });

      expect(applied).toBe(true);
      expect(await db.prescriptions.get('p1')).toMatchObject({ id: 'p1', dosesLeft: 4 });
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('deletes a prescription when the remote delete wins', async () => {
    await db.prescriptions.put({ id: 'p1', type: SEMA, createdAt: MID, updatedAt: MID });
    const applied = await applyRemoteChange({
      aggregate: 'prescription',
      entityId: 'p1',
      op: 'delete',
      record: null,
      remoteUpdatedAt: NEW,
    });
    expect(applied).toBe(true);
    expect(await db.prescriptions.get('p1')).toBeUndefined();
  });
});

describe('applyRemoteChange — profile', () => {
  const localProfile: ProfileSettings = {
    id: 'profile',
    passphraseEnabled: true,
    syncMode: 'e2ee',
    startWeight: 200,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: MID,
  };

  it('merges synced fields but preserves device-local sync state', async () => {
    await db.profile.put(localProfile);
    const applied = await applyRemoteChange({
      aggregate: 'profile',
      entityId: 'profile',
      op: 'upsert',
      // What a synced profile looks like: no syncMode/e2eeMigration, passphraseEnabled false.
      record: {
        id: 'profile',
        passphraseEnabled: false,
        startWeight: 180,
        goalWeight: 150,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: NEW,
      },
      remoteUpdatedAt: NEW,
    });

    expect(applied).toBe(true);
    const after = (await db.profile.get('profile'))!;
    // synced user fields applied
    expect(after.startWeight).toBe(180);
    expect(after.goalWeight).toBe(150);
    // device-local sync state untouched
    expect(after.syncMode).toBe('e2ee');
    expect(after.passphraseEnabled).toBe(true);
    expect(after.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('skips a profile upsert that is older than the local copy', async () => {
    await db.profile.put(localProfile);
    const applied = await applyRemoteChange({
      aggregate: 'profile',
      entityId: 'profile',
      op: 'upsert',
      record: { id: 'profile', passphraseEnabled: false, startWeight: 999, updatedAt: OLD },
      remoteUpdatedAt: OLD,
    });

    expect(applied).toBe(false);
    expect((await db.profile.get('profile'))!.startWeight).toBe(200);
  });

  it('ignores a profile delete — the local profile holds device sync state', async () => {
    await db.profile.put(localProfile);
    const applied = await applyRemoteChange({
      aggregate: 'profile',
      entityId: 'profile',
      op: 'delete',
      record: null,
      remoteUpdatedAt: NEW,
    });

    expect(applied).toBe(false);
    expect(await db.profile.get('profile')).toBeDefined();
  });
});

describe('applyRemoteChange — outbox reconciliation', () => {
  async function seedOutbox(id: string, updatedAt: string) {
    const [aggregate, entityId] = id.split(':');
    await db.outbox.put({
      id,
      aggregate: aggregate as 'weight' | 'injection' | 'prescription' | 'profile',
      entityId,
      op: 'upsert',
      updatedAt,
      payload: { id: entityId },
      enqueuedAt: updatedAt,
      rev: `rev-${updatedAt}`,
    });
  }

  it('drops a pending outbox entry that the applied change supersedes', async () => {
    // Local edit at MID is queued to push...
    await db.weights.put(weight('w1', MID));
    await seedOutbox('weight:w1', MID);

    // ...but a newer remote edit arrives and is applied.
    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'upsert',
      record: weight('w1', NEW, 160),
      remoteUpdatedAt: NEW,
    });

    expect(applied).toBe(true);
    // The stale outbox entry is gone, so the next push can't clobber the cloud.
    expect(await db.outbox.get('weight:w1')).toBeUndefined();
  });

  it('drops the outbox entry when a remote delete is applied', async () => {
    await db.injections.put(injection('i1', MID));
    await seedOutbox('injection:i1', MID);

    await applyRemoteChange({
      aggregate: 'injection',
      entityId: 'i1',
      op: 'delete',
      record: null,
      remoteUpdatedAt: NEW,
    });

    expect(await db.outbox.get('injection:i1')).toBeUndefined();
  });

  it('keeps a genuinely newer pending outbox entry', async () => {
    // Defensive: a pending local edit newer than the applied change survives.
    await db.weights.put(weight('w1', OLD));
    await seedOutbox('weight:w1', NEW);

    await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'upsert',
      record: weight('w1', MID, 160),
      remoteUpdatedAt: MID,
    });

    expect(await db.outbox.get('weight:w1')).toBeDefined();
  });

  it('leaves the outbox untouched when the remote change loses LWW', async () => {
    await db.weights.put(weight('w1', NEW));
    await seedOutbox('weight:w1', NEW);

    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'upsert',
      record: weight('w1', OLD, 160),
      remoteUpdatedAt: OLD,
    });

    expect(applied).toBe(false);
    expect(await db.outbox.get('weight:w1')).toBeDefined();
  });
});

describe('applyRemoteChange — weight per-field LWW', () => {
  function stampedWeight(
    id: string,
    fields: { weightLbs?: number; wellness?: number; symptoms?: string[] },
    fieldUpdatedAt: Record<string, string>,
    rowUpdatedAt: string,
  ): WeightEntry {
    return {
      id,
      date: iso('2026-05-10'),
      ...fields,
      createdAt: OLD,
      updatedAt: rowUpdatedAt,
      fieldUpdatedAt,
    };
  }

  it('preserves a local field edit when the remote edited a different field', async () => {
    // Initial shared state at OLD, both fields stamped OLD.
    await db.weights.put(
      stampAllFields(
        {
          id: 'w1',
          date: iso('2026-05-10'),
          weightLbs: 180,
          wellness: 5,
          symptoms: ['nausea'],
          createdAt: OLD,
          updatedAt: OLD,
        },
        OLD,
      ),
    );
    // Local device bumped `symptoms` at MID.
    await updateWeight('w1', { symptoms: ['nausea', 'fatigue'] });

    // Remote (other device) bumped `wellness` at NEW.
    const remote = stampedWeight(
      'w1',
      { weightLbs: 180, wellness: 7, symptoms: ['nausea'] },
      { weightLbs: OLD, wellness: NEW, symptoms: OLD },
      NEW,
    );
    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'upsert',
      record: remote,
      remoteUpdatedAt: NEW,
    });

    expect(applied).toBe(true);
    const after = (await db.weights.get('w1'))!;
    // Both edits survive — the central guarantee.
    expect(after.symptoms).toEqual(['nausea', 'fatigue']);
    expect(after.wellness).toBe(7);
    // Row clock advances to at least the remote's latest stamp; the local
    // updateWeight call uses real `now()` so the actual max is wall-clock.
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(NEW).getTime());
    // Per-field stamps reflect who won each field.
    expect(after.fieldUpdatedAt!.wellness).toBe(NEW);
  });

  it('re-enqueues the merged snapshot when local wins any field', async () => {
    await db.weights.put(
      stampAllFields(
        {
          id: 'w2',
          date: iso('2026-05-10'),
          weightLbs: 180,
          wellness: 5,
          symptoms: ['nausea'],
          createdAt: OLD,
          updatedAt: OLD,
        },
        OLD,
      ),
    );
    // Local edits symptoms at NEW. addWeight/updateWeight enqueue to outbox,
    // and on a real device that push would be sitting pending while offline.
    await updateWeight('w2', { symptoms: ['fatigue'] });

    // Remote arrives with an older wellness edit at MID. Local wins symptoms
    // (NEW > OLD), remote wins wellness (MID > OLD).
    const remote = stampedWeight(
      'w2',
      { weightLbs: 180, wellness: 9, symptoms: ['nausea'] },
      { weightLbs: OLD, wellness: MID, symptoms: OLD },
      MID,
    );
    await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w2',
      op: 'upsert',
      record: remote,
      remoteUpdatedAt: MID,
    });

    // The outbox payload must reflect the merged state, not the pre-merge
    // local snapshot — otherwise pushing it would clobber the remote's
    // wellness=9 back to the local pre-merge wellness=5 on the cloud.
    const outbox = await db.outbox.get('weight:w2');
    expect(outbox).toBeDefined();
    const payload = outbox!.payload as WeightEntry;
    expect(payload.symptoms).toEqual(['fatigue']);
    expect(payload.wellness).toBe(9);
  });

  it('drops the outbox when the remote is strictly newer on every field', async () => {
    // A standard "remote fully supersedes local" case — the outbox must be
    // cleared so the next push doesn't clobber the cloud's newer state.
    await db.weights.put(
      stampAllFields(
        {
          id: 'w3',
          date: iso('2026-05-10'),
          weightLbs: 180,
          wellness: 5,
          createdAt: OLD,
          updatedAt: MID,
        },
        MID,
      ),
    );
    // Enqueue a pending local outbox at MID.
    await db.outbox.put({
      id: 'weight:w3',
      aggregate: 'weight',
      entityId: 'w3',
      op: 'upsert',
      updatedAt: MID,
      payload: { id: 'w3' },
      enqueuedAt: MID,
      rev: 'stub',
    });

    const remote = stampedWeight(
      'w3',
      { weightLbs: 175, wellness: 7 },
      { weightLbs: NEW, wellness: NEW },
      NEW,
    );
    await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w3',
      op: 'upsert',
      record: remote,
      remoteUpdatedAt: NEW,
    });

    expect(await db.outbox.get('weight:w3')).toBeUndefined();
  });

  it('merges sensibly against a legacy remote record with no fieldUpdatedAt', async () => {
    // Forward-compat the other direction: an older client pushes a record
    // without per-field stamps. Every remote field's clock is the remote row
    // updatedAt; local per-field clocks decide who wins.
    await db.weights.put(
      stampAllFields(
        {
          id: 'w4',
          date: iso('2026-05-10'),
          weightLbs: 180,
          wellness: 5,
          createdAt: OLD,
          updatedAt: OLD,
        },
        OLD,
      ),
    );
    await updateWeight('w4', { wellness: 9 }); // local wellness stamped NEW-ish

    const legacy: WeightEntry = {
      id: 'w4',
      date: iso('2026-05-10'),
      weightLbs: 175,
      wellness: 7,
      createdAt: OLD,
      updatedAt: MID, // every field is treated as stamped MID
    };
    await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w4',
      op: 'upsert',
      record: legacy,
      remoteUpdatedAt: MID,
    });

    const after = (await db.weights.get('w4'))!;
    expect(after.weightLbs).toBe(175); // remote MID > local OLD
    expect(after.wellness).toBe(9);     // local stamp from updateWeight > MID
  });

  it('end-to-end: addWeight then updateWeight produces complete per-field stamps', async () => {
    // Pin the clock so the create and update land on distinct, ordered
    // timestamps. `repo.now()` is `new Date().toISOString()`; faking only Date
    // (not timers/microtasks) keeps fake-indexeddb working. Without this the
    // two writes can collide in the same millisecond and the "wellness stamp
    // moved" assertions flake.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'));
      const created = await addWeight({ weightLbs: 180, wellness: 5 });
      expect(created.fieldUpdatedAt).toMatchObject({
        weightLbs: created.updatedAt,
        wellness: created.updatedAt,
      });

      vi.setSystemTime(new Date('2026-05-10T00:00:01.000Z'));
      await updateWeight(created.id, { wellness: 7 });
      const after = (await db.weights.get(created.id))!;
      // Only wellness's stamp moved; weightLbs stays at the original creation
      // time so a remote that edits weightLbs later wins it cleanly.
      expect(after.fieldUpdatedAt!.weightLbs).toBe(created.fieldUpdatedAt!.weightLbs);
      expect(after.fieldUpdatedAt!.wellness).not.toBe(created.fieldUpdatedAt!.wellness);
      expect(new Date(after.fieldUpdatedAt!.wellness).getTime())
        .toBeGreaterThan(new Date(created.fieldUpdatedAt!.wellness).getTime());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('field-clear tombstones', () => {
  it('updateWeight with an `undefined` value removes the field locally and stamps it', async () => {
    // Pin the clock so the clear's stamp is provably newer than creation's
    // (same-millisecond collisions otherwise flake the ordering assertion).
    // Fake only Date — not timers/microtasks — so fake-indexeddb keeps working.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'));
      const created = await addWeight({ weightLbs: 180, wellness: 5 });
      vi.setSystemTime(new Date('2026-05-10T00:00:01.000Z'));
      await updateWeight(created.id, { wellness: undefined });

      const after = (await db.weights.get(created.id))!;
      // Field is gone from the row (not lingering as `undefined`).
      expect('wellness' in after).toBe(false);
      // But the field-clock entry survives — that's what tells receivers the
      // absence is intentional and newer than their value.
      expect(after.fieldUpdatedAt!.wellness).toBeDefined();
      expect(new Date(after.fieldUpdatedAt!.wellness).getTime())
        .toBeGreaterThan(new Date(created.fieldUpdatedAt!.wellness).getTime());

      // The outbox payload (what will be pushed) matches: key absent, stamp present.
      const outbox = await db.outbox.get(`weight:${created.id}`);
      const payload = outbox!.payload as WeightEntry;
      expect('wellness' in payload).toBe(false);
      expect(payload.fieldUpdatedAt!.wellness).toBe(after.fieldUpdatedAt!.wellness);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a remote tombstone (stamp present, value absent) drops the local field', async () => {
    // Local at OLD with wellness=5; remote arrives stamping wellness at NEW
    // but with no value — the canonical cleared-field shape on the wire.
    await db.weights.put(
      stampAllFields(
        {
          id: 'w1',
          date: iso('2026-05-10'),
          weightLbs: 180,
          wellness: 5,
          createdAt: OLD,
          updatedAt: OLD,
        },
        OLD,
      ),
    );
    const tombstone: WeightEntry = {
      id: 'w1',
      date: iso('2026-05-10'),
      weightLbs: 180,
      createdAt: OLD,
      updatedAt: NEW,
      fieldUpdatedAt: { date: OLD, weightLbs: OLD, wellness: NEW },
      // wellness key deliberately absent
    };
    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w1',
      op: 'upsert',
      record: tombstone,
      remoteUpdatedAt: NEW,
    });

    expect(applied).toBe(true);
    const after = (await db.weights.get('w1'))!;
    expect(after.wellness).toBeUndefined();
    // Stamp carries forward so a third device pulling can't re-set the field
    // with an older value.
    expect(after.fieldUpdatedAt!.wellness).toBe(NEW);
  });

  it('a local edit newer than a remote tombstone keeps the local value', async () => {
    // Local clears wellness at... actually no — local sets wellness fresh
    // while a remote tombstone for the same field has an older stamp. The
    // local value must survive.
    await db.weights.put(
      stampAllFields(
        {
          id: 'w2',
          date: iso('2026-05-10'),
          wellness: 9,
          createdAt: OLD,
          updatedAt: NEW,
          fieldUpdatedAt: { date: OLD, wellness: NEW },
        } as WeightEntry,
        OLD, // baseline stamp for non-wellness fields
      ),
    );
    // Force the just-set local wellness stamp to NEW (the helper above
    // stamps to OLD; manually override for clarity).
    const seeded = await db.weights.get('w2');
    await db.weights.put({
      ...seeded!,
      fieldUpdatedAt: { ...seeded!.fieldUpdatedAt!, wellness: NEW },
      updatedAt: NEW,
    });

    const tombstone: WeightEntry = {
      id: 'w2',
      date: iso('2026-05-10'),
      createdAt: OLD,
      updatedAt: MID,
      fieldUpdatedAt: { date: OLD, wellness: MID }, // older tombstone
    };
    await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'w2',
      op: 'upsert',
      record: tombstone,
      remoteUpdatedAt: MID,
    });

    const after = (await db.weights.get('w2'))!;
    expect(after.wellness).toBe(9);
    expect(after.fieldUpdatedAt!.wellness).toBe(NEW);
  });
});

describe('applyRemoteChange — injection per-field LWW', () => {
  it('preserves a local field edit when the remote edited a different field', async () => {
    // Both devices start from the same baseline at OLD.
    const baseline = stampAllFields(
      {
        id: 'i1',
        date: iso('2026-05-10'),
        amountMg: 5,
        site: 'left thigh',
        medication: SEMA,
        symptoms: ['nausea'],
        createdAt: OLD,
        updatedAt: OLD,
      } as InjectionEntry,
      OLD,
    );
    await db.injections.put(baseline);
    // Local edits `site` via the repo write path (real stamps land via
    // bumpFieldStamps, mirroring an offline edit on this device).
    await updateInjection('i1', { site: 'right arm' });

    // Remote arrives having edited `amountMg` at NEW; everything else still
    // stamped OLD.
    const remote: InjectionEntry = {
      ...baseline,
      amountMg: 7,
      updatedAt: NEW,
      fieldUpdatedAt: { ...baseline.fieldUpdatedAt!, amountMg: NEW },
    };
    await applyRemoteChange({
      aggregate: 'injection',
      entityId: 'i1',
      op: 'upsert',
      record: remote,
      remoteUpdatedAt: NEW,
    });

    const after = (await db.injections.get('i1'))!;
    expect(after.site).toBe('right arm'); // local survives
    expect(after.amountMg).toBe(7);        // remote applied
  });
});

describe('applyRemoteChange — profile per-field LWW', () => {
  // saveProfile uses real wall-clock now(), which leaks into per-field stamps
  // and makes test-clock comparisons (OLD/MID/NEW) meaningless. Set up local
  // state directly with the constants we want to assert against.
  async function putProfileDirect(
    fields: { startWeight?: number; goalWeight?: number },
    stamps: Record<string, string>,
    row: { passphraseEnabled?: boolean; syncMode?: 'plain' | 'e2ee' },
    rowUpdatedAt: string,
  ): Promise<void> {
    await db.profile.put({
      id: 'profile',
      passphraseEnabled: row.passphraseEnabled ?? false,
      syncMode: row.syncMode,
      ...fields,
      createdAt: OLD,
      updatedAt: rowUpdatedAt,
      fieldUpdatedAt: stamps,
    });
  }

  it('takes a synced field from remote but never touches device-local state', async () => {
    await putProfileDirect(
      { startWeight: 200 },
      { startWeight: OLD },
      { passphraseEnabled: true, syncMode: 'e2ee' },
      OLD,
    );

    const remote = {
      id: 'profile' as const,
      passphraseEnabled: false,
      syncMode: 'plain' as const, // would normally never appear on the wire
      startWeight: 180,
      goalWeight: 150,
      createdAt: OLD,
      updatedAt: NEW,
    };
    await applyRemoteChange({
      aggregate: 'profile',
      entityId: 'profile',
      op: 'upsert',
      record: remote,
      remoteUpdatedAt: NEW,
    });

    const after = (await db.profile.get('profile'))!;
    expect(after.startWeight).toBe(180);     // synced: remote newer
    expect(after.goalWeight).toBe(150);      // synced: remote newer
    expect(after.passphraseEnabled).toBe(true); // device-local: preserved
    expect(after.syncMode).toBe('e2ee');         // device-local: preserved
    // No field-clock entry should have been minted for the reserved fields.
    expect(after.fieldUpdatedAt).toBeDefined();
    expect(Object.keys(after.fieldUpdatedAt!)).not.toContain('passphraseEnabled');
    expect(Object.keys(after.fieldUpdatedAt!)).not.toContain('syncMode');
  });

  it('keeps a local syncable field edit when a different field arrives from remote', async () => {
    // The real win: two profile settings can be edited concurrently on two
    // devices without one clobbering the other.
    await putProfileDirect(
      { startWeight: 200, goalWeight: 140 },
      { startWeight: OLD, goalWeight: NEW }, // local bumped goalWeight at NEW
      { passphraseEnabled: false },
      NEW,
    );

    const remote = {
      id: 'profile' as const,
      passphraseEnabled: false,
      startWeight: 180,
      goalWeight: 150, // remote's stale view of goalWeight — must not win
      createdAt: OLD,
      updatedAt: MID,
      fieldUpdatedAt: {
        startWeight: MID,           // newer than local's startWeight stamp
        goalWeight: OLD,            // older than local's goalWeight stamp
      },
    };
    await applyRemoteChange({
      aggregate: 'profile',
      entityId: 'profile',
      op: 'upsert',
      record: remote,
      remoteUpdatedAt: MID,
    });

    const after = (await db.profile.get('profile'))!;
    expect(after.startWeight).toBe(180);  // remote wins startWeight
    expect(after.goalWeight).toBe(140);   // local wins goalWeight
  });
});

describe('applyRemoteChange — malformed null-record upserts', () => {
  // Regression for the "null is not an object (evaluating 'e[t]')" migration
  // crash: an older E2EE *disable* migration wrote plaintext rows without the
  // `{aggregate, op, record}` envelope, so `pullPlain` decodes their record as
  // null. Applying such a row used to `db.<table>.put(null)` and throw inside
  // Dexie's key-path extraction, aborting the whole pull / enable migration.
  it('skips a null-record weight upsert without throwing or writing', async () => {
    let applied: boolean | undefined;
    await expect(
      (async () => {
        applied = await applyRemoteChange({
          aggregate: 'weight',
          entityId: 'plain:weight:w1',
          op: 'upsert',
          record: null,
          remoteUpdatedAt: MID,
        });
      })(),
    ).resolves.toBeUndefined();
    expect(applied).toBe(false);
    expect(await db.weights.count()).toBe(0);
  });

  it('skips a null-record profile upsert without throwing', async () => {
    const applied = await applyRemoteChange({
      aggregate: 'profile',
      entityId: 'profile',
      op: 'upsert',
      record: undefined,
      remoteUpdatedAt: MID,
    });
    expect(applied).toBe(false);
  });

  it('still applies a well-formed upsert after a malformed one (one bad row does not poison the pull)', async () => {
    await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'bad',
      op: 'upsert',
      record: null,
      remoteUpdatedAt: MID,
    });
    const good = stampAllFields(
      { id: 'good', date: iso('2026-05-10'), weightLbs: 200, createdAt: MID, updatedAt: MID },
      MID,
    ) as WeightEntry;
    const applied = await applyRemoteChange({
      aggregate: 'weight',
      entityId: 'good',
      op: 'upsert',
      record: good,
      remoteUpdatedAt: MID,
    });
    expect(applied).toBe(true);
    expect((await db.weights.get('good'))!.weightLbs).toBe(200);
  });
});

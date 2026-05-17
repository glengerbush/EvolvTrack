import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { db } from '$lib/db/schema';
import {
  applyRemoteChange,
  onHealthDataChange,
  type HealthDataChange,
} from '$lib/domain/repo';
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

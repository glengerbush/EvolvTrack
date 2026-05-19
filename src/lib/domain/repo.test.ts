import { describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import {
  addInjection,
  addPrescription,
  addWeight,
  bulkUpdateInjections,
  bulkUpdatePrescriptions,
  clearAllData,
  deleteInjection,
  deleteWeight,
  getAllInjections,
  getAllPrescriptions,
  onHealthDataChange,
  type HealthDataChange,
  updateInjection,
  updateWeight,
} from '$lib/domain/repo';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TODAY = iso('2026-05-10');

function captureChanges() {
  const events: HealthDataChange[] = [];
  const unsubscribe = onHealthDataChange((c) => events.push(c));
  return { events, unsubscribe };
}

describe('repo health-change events', () => {
  it('emits add then patch then delete for a weight lifecycle', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      const created = await addWeight({ date: TODAY, weightLbs: 180 });
      await updateWeight(created.id, { weightLbs: 178 });
      await deleteWeight(created.id);

      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ kind: 'weight', action: 'add' });
      expect((events[0] as Extract<HealthDataChange, { action: 'add' }>).entity).toMatchObject({
        id: created.id,
        date: TODAY,
        weightLbs: 180,
      });
      expect(events[1]).toMatchObject({ kind: 'weight', action: 'patch', id: created.id });
      const patch = (events[1] as Extract<HealthDataChange, { action: 'patch' }>).patch;
      expect(patch).toMatchObject({ weightLbs: 178 });
      expect(patch).toHaveProperty('updatedAt');
      expect(events[2]).toMatchObject({ kind: 'weight', action: 'delete', id: created.id });
    } finally {
      unsubscribe();
    }
  });

  it('emits add then patch then delete for an injection lifecycle', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      const created = await addInjection({
        date: TODAY,
        amountMg: 5,
        medication: SEMA,
        site: '',
        symptoms: [],
      });
      await updateInjection(created.id, { amountMg: 7 });
      await deleteInjection(created.id);

      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ kind: 'injection', action: 'add' });
      expect((events[0] as Extract<HealthDataChange, { action: 'add' }>).entity).toMatchObject({
        id: created.id,
        amountMg: 5,
        medication: SEMA,
      });
      expect(events[1]).toMatchObject({ kind: 'injection', action: 'patch', id: created.id });
      expect((events[1] as Extract<HealthDataChange, { action: 'patch' }>).patch).toMatchObject({
        amountMg: 7,
      });
      expect(events[2]).toMatchObject({ kind: 'injection', action: 'delete', id: created.id });
    } finally {
      unsubscribe();
    }
  });

  it('clearAllData emits reset for both weight and injection kinds', async () => {
    const { events, unsubscribe } = captureChanges();
    try {
      await clearAllData();
      const resets = events.filter((e) => e.action === 'reset');
      expect(resets.map((e) => e.kind).sort()).toEqual(['injection', 'weight']);
    } finally {
      unsubscribe();
    }
  });

  it('unsubscribe stops further events from reaching the listener', async () => {
    const listener = vi.fn();
    const off = onHealthDataChange(listener);
    await addWeight({ date: TODAY, weightLbs: 180 });
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    await addWeight({ date: TODAY, weightLbs: 181 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Regression: a previous version of the import-backfill flow called
  // updateInjection in a sequential await loop, which produced one transaction
  // and one store-rebuilding event per row. The bulk variant must collapse
  // both: every patched row persists, and listeners see a single bulkPatch
  // event that names every id.
  it('bulkUpdateInjections persists every patched row and emits exactly one bulkPatch event', async () => {
    const created = await Promise.all([
      addInjection({ date: TODAY, amountMg: 1, medication: '', site: '', symptoms: [] }),
      addInjection({ date: TODAY, amountMg: 2, medication: '', site: '', symptoms: [] }),
      addInjection({ date: TODAY, amountMg: 3, medication: '', site: '', symptoms: [] }),
    ]);
    const ids = created.map((i) => i.id);

    const { events, unsubscribe } = captureChanges();
    try {
      await bulkUpdateInjections(ids, { medication: SEMA });

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event).toMatchObject({ kind: 'injection', action: 'bulkPatch' });
      const bulk = event as Extract<HealthDataChange, { action: 'bulkPatch' }>;
      expect(bulk.ids).toEqual(ids);
      expect(bulk.patch).toMatchObject({ medication: SEMA });
      expect(bulk.patch).toHaveProperty('updatedAt');

      const persisted = await getAllInjections();
      expect(persisted).toHaveLength(3);
      for (const row of persisted) {
        expect(row.medication).toBe(SEMA);
        expect(row.updatedAt).toBe(bulk.patch.updatedAt);
      }
    } finally {
      unsubscribe();
    }
  });

  // Mirror of bulkUpdateInjections, used by the import flow to backfill a
  // medication type onto vial rows that arrived without one. Prescriptions are
  // observed via liveQuery so no health-change event is emitted, but every row
  // must still be patched in a single transaction.
  it('bulkUpdatePrescriptions persists every patched row without emitting events', async () => {
    const created = await Promise.all([
      addPrescription({ concentrationMgMl: 5 }),
      addPrescription({ concentrationMgMl: 10 }),
      addPrescription({ concentrationMgMl: 15 }),
    ]);
    const ids = created.map((p) => p.id);

    const { events, unsubscribe } = captureChanges();
    try {
      await bulkUpdatePrescriptions(ids, { type: SEMA });
      expect(events).toHaveLength(0);

      const persisted = await getAllPrescriptions();
      const byId = new Map(persisted.map((p) => [p.id, p]));
      for (const id of ids) {
        expect(byId.get(id)?.type).toBe(SEMA);
      }
    } finally {
      unsubscribe();
    }
  });

  it('bulkUpdateInjections stamps the patched field per row without touching siblings', async () => {
    // Confirms per-field LWW for the bulk path: each row gets `medication`
    // bumped to a fresh stamp, but every row's other fields keep their own
    // pre-edit stamps. Without this, a concurrent edit to e.g. `amountMg` on
    // another device could be silently clobbered by the bulk push.
    const created = await Promise.all([
      addInjection({ date: TODAY, amountMg: 1, medication: '', site: '', symptoms: [] }),
      addInjection({ date: TODAY, amountMg: 2, medication: '', site: '', symptoms: [] }),
    ]);
    const ids = created.map((i) => i.id);
    const originalAmountStamps = created.map((i) => i.fieldUpdatedAt!.amountMg);

    await bulkUpdateInjections(ids, { medication: SEMA });

    const persisted = await getAllInjections();
    const byId = new Map(persisted.map((i) => [i.id, i]));
    for (let i = 0; i < ids.length; i++) {
      const row = byId.get(ids[i])!;
      // Patched field's stamp moved forward...
      expect(new Date(row.fieldUpdatedAt!.medication).getTime())
        .toBeGreaterThanOrEqual(new Date(originalAmountStamps[i]).getTime());
      // ...but the unpatched per-row stamp is preserved.
      expect(row.fieldUpdatedAt!.amountMg).toBe(originalAmountStamps[i]);
    }
  });

  it('bulkUpdatePrescriptions with an empty id list writes nothing', async () => {
    const created = await addPrescription({ type: SEMA, concentrationMgMl: 5 });

    await bulkUpdatePrescriptions([], { type: 'Tirzepatide (Mounjaro / Zepbound)' });

    const persisted = await getAllPrescriptions();
    expect(persisted.find((p) => p.id === created.id)?.type).toBe(SEMA);
  });

  it('bulkUpdateInjections with an empty id list emits nothing and writes nothing', async () => {
    const created = await addInjection({
      date: TODAY,
      amountMg: 5,
      medication: SEMA,
      site: '',
      symptoms: [],
    });

    const { events, unsubscribe } = captureChanges();
    try {
      await bulkUpdateInjections([], { medication: 'Tirzepatide (Mounjaro / Zepbound)' });
      expect(events).toHaveLength(0);
      const persisted = await getAllInjections();
      expect(persisted[0]).toMatchObject({ id: created.id, medication: SEMA });
    } finally {
      unsubscribe();
    }
  });

  it('multiple subscribers each see every event', async () => {
    const a: HealthDataChange[] = [];
    const b: HealthDataChange[] = [];
    const offA = onHealthDataChange((c) => a.push(c));
    const offB = onHealthDataChange((c) => b.push(c));
    try {
      await addWeight({ date: TODAY, weightLbs: 180 });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    } finally {
      offA();
      offB();
    }
  });
});

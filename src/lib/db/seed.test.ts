import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { clearDemoData, seedDemoData } from '$lib/db/seed';
import {
  addInjection,
  addPrescription,
  addWeight,
  getAllInjections,
  getAllPrescriptions,
  getAllWeights,
  getProfile,
  saveProfile,
} from '$lib/domain/repo';
import { addDays, daysBetween, localDateKey } from '$lib/utils/dateKeys';
import type { IsoDate } from '$lib/domain/types';

const SEMA = 'Semaglutide (Ozempic / Wegovy)';
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';

/**
 * Mirror the seed's calendar-month math so the test isn't dependent on the
 * concrete date the test runs on.
 */
function addCalendarMonths(dateKey: IsoDate, months: number): IsoDate {
  const [year, month, day] = dateKey.split('-').map(Number);
  const target = new Date(year, month - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const d = String(target.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}` as IsoDate;
}

describe('seedDemoData', () => {
  it('populates one weight entry per day in the rolling one-month window', async () => {
    await seedDemoData();
    const today = localDateKey();
    const startDate = addCalendarMonths(today, -1);
    const expected = daysBetween(startDate, today) + 1;

    const weights = await getAllWeights();
    expect(weights).toHaveLength(expected);

    const dates = weights.map((w) => w.date);
    expect(dates).toContain(today);
    expect(dates).toContain(startDate);

    // Every entry should have a weight in lbs and a wellness value.
    for (const w of weights) {
      expect(typeof w.weightLbs).toBe('number');
      expect(typeof w.wellness).toBe('number');
    }
  });

  it('creates one injection per week ending on today, all Semaglutide', async () => {
    await seedDemoData();
    const today = localDateKey();
    const startDate = addCalendarMonths(today, -1);

    const expectedDoses: IsoDate[] = [];
    for (let date: IsoDate = today; date >= startDate; date = addDays(date, -7)) {
      expectedDoses.unshift(date);
    }

    const injections = await getAllInjections();
    expect(injections).toHaveLength(expectedDoses.length);
    expect(injections.map((i) => i.date).sort()).toEqual([...expectedDoses].sort());

    for (const inj of injections) {
      expect(inj.medication).toBe(SEMA);
      expect([2.5, 5]).toContain(inj.amountMg);
    }
  });

  it('marks today\'s injection as planned and past injections as confirmed', async () => {
    await seedDemoData();
    const today = localDateKey();
    const injections = await getAllInjections();

    const todaysDose = injections.find((i) => i.date === today);
    expect(todaysDose).toBeDefined();
    expect(todaysDose!.planned).toBe(true);
    expect(todaysDose!.confirmedAt).toBeUndefined();

    for (const inj of injections) {
      if (inj.date === today) continue;
      expect(inj.confirmedAt).toBeTruthy();
      expect(inj.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T14:00:00\.000Z$/);
      expect(inj.planned).toBeFalsy();
    }
  });

  it('inserts six prescriptions (3 Sema vials, 3 Tirz vials)', async () => {
    await seedDemoData();
    const prescriptions = await getAllPrescriptions();
    expect(prescriptions).toHaveLength(6);

    const byType = prescriptions.reduce<Record<string, number>>((acc, p) => {
      const key = p.type ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType[SEMA]).toBe(3);
    expect(byType[TIRZ]).toBe(3);

    // Every seeded prescription has the metadata fields the dashboard needs.
    for (const p of prescriptions) {
      expect(typeof p.concentrationMgMl).toBe('number');
      expect(typeof p.vialMl).toBe('number');
      expect(typeof p.prescribedDoseMg).toBe('number');
      expect(typeof p.costUsd).toBe('number');
      expect(typeof p.lotNumber).toBe('string');
    }
  });

  it('clears any pre-existing data before seeding (idempotent)', async () => {
    // Seed twice — counts should remain stable, not double.
    await seedDemoData();
    const firstWeightCount = (await getAllWeights()).length;
    const firstInjectionCount = (await getAllInjections()).length;
    const firstPrescriptionCount = (await getAllPrescriptions()).length;

    await seedDemoData();
    expect((await getAllWeights()).length).toBe(firstWeightCount);
    expect((await getAllInjections()).length).toBe(firstInjectionCount);
    expect((await getAllPrescriptions()).length).toBe(firstPrescriptionCount);
  });

  it('wipes any pre-existing user data when called', async () => {
    // Pre-populate with rows that should not survive seed.
    const today = localDateKey();
    await addWeight({ date: today, weightLbs: 999 });
    await addInjection({
      date: today,
      amountMg: 99,
      medication: SEMA,
      site: 'unknown',
      symptoms: [],
    });
    await addPrescription({ type: SEMA, lotNumber: 'pre-existing' });
    await saveProfile({ startWeight: 200 });

    await seedDemoData();

    // No 999-lb weight, no 99 mg dose, no 'pre-existing' lot.
    const weights = await getAllWeights();
    expect(weights.some((w) => w.weightLbs === 999)).toBe(false);
    const injections = await getAllInjections();
    expect(injections.some((i) => i.amountMg === 99)).toBe(false);
    const prescriptions = await getAllPrescriptions();
    expect(prescriptions.some((p) => p.lotNumber === 'pre-existing')).toBe(false);
    // Profile is cleared by clearAllData inside seedDemoData.
    expect(await getProfile()).toBeUndefined();
  });
});

describe('clearDemoData', () => {
  it('removes everything seeded by seedDemoData', async () => {
    await seedDemoData();
    expect((await getAllWeights()).length).toBeGreaterThan(0);
    expect((await getAllInjections()).length).toBeGreaterThan(0);
    expect((await getAllPrescriptions()).length).toBeGreaterThan(0);

    await clearDemoData();

    expect(await getAllWeights()).toEqual([]);
    expect(await getAllInjections()).toEqual([]);
    expect(await getAllPrescriptions()).toEqual([]);
    expect(await getProfile()).toBeUndefined();
  });

  it('is a no-op when there is no data to clear', async () => {
    await expect(clearDemoData()).resolves.toBeUndefined();
    expect(await getAllWeights()).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { clearDemoData, seedDemoData } from '$lib/db/seed';
import {
  addEntry,
  addPrescription,
  getAllEntries,
  getAllPrescriptions,
  getProfile,
  saveProfile,
} from '$lib/domain/health-data-storage';
import { addDays, daysBetween, localDateKey } from '$lib/utils/dateKeys';
import type { HealthEntry, IsoDate } from '$lib/domain/types';

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

const doses = (entries: HealthEntry[]) => entries.filter((e) => e.amountMg != null);

describe('seedDemoData', () => {
  it('populates one entry per day in the rolling one-month window, each with a weigh-in', async () => {
    await seedDemoData();
    const today = localDateKey();
    const startDate = addCalendarMonths(today, -1);
    const expected = daysBetween(startDate, today) + 1;

    const entries = await getAllEntries();
    expect(entries).toHaveLength(expected);

    const dates = entries.map((e) => e.date);
    expect(dates).toContain(today);
    expect(dates).toContain(startDate);

    // Every day entry should have a weight in lbs and a wellness value.
    for (const e of entries) {
      expect(typeof e.weightLbs).toBe('number');
      expect(typeof e.wellness).toBe('number');
    }
  });

  it('merges one dose per week (ending today) onto its day entry, all Semaglutide', async () => {
    await seedDemoData();
    const today = localDateKey();
    const startDate = addCalendarMonths(today, -1);

    const expectedDoses: IsoDate[] = [];
    for (let date: IsoDate = today; date >= startDate; date = addDays(date, -7)) {
      expectedDoses.unshift(date);
    }

    const doseEntries = doses(await getAllEntries());
    expect(doseEntries).toHaveLength(expectedDoses.length);
    expect(doseEntries.map((e) => e.date).sort()).toEqual([...expectedDoses].sort());

    for (const e of doseEntries) {
      expect(e.medication).toBe(SEMA);
      expect([2.5, 5]).toContain(e.amountMg);
    }
  });

  it("marks today's dose as planned and past doses as confirmed", async () => {
    await seedDemoData();
    const today = localDateKey();
    const doseEntries = doses(await getAllEntries());

    const todaysDose = doseEntries.find((e) => e.date === today);
    expect(todaysDose).toBeDefined();
    expect(todaysDose!.planned).toBe(true);
    expect(todaysDose!.confirmedAt).toBeUndefined();

    for (const e of doseEntries) {
      if (e.date === today) continue;
      expect(e.confirmedAt).toBeTruthy();
      expect(e.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T14:00:00\.000Z$/);
      expect(e.planned).toBeFalsy();
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

    for (const p of prescriptions) {
      expect(typeof p.concentrationMgMl).toBe('number');
      expect(typeof p.vialMl).toBe('number');
      expect(typeof p.prescribedDoseMg).toBe('number');
      expect(typeof p.costUsd).toBe('number');
      expect(typeof p.lotNumber).toBe('string');
    }
  });

  it('clears any pre-existing data before seeding (idempotent)', async () => {
    await seedDemoData();
    const firstEntryCount = (await getAllEntries()).length;
    const firstPrescriptionCount = (await getAllPrescriptions()).length;

    await seedDemoData();
    expect((await getAllEntries()).length).toBe(firstEntryCount);
    expect((await getAllPrescriptions()).length).toBe(firstPrescriptionCount);
  });

  it('wipes any pre-existing user data when called', async () => {
    const today = localDateKey();
    await addEntry({ date: today, weightLbs: 999 });
    await addEntry({ date: today, amountMg: 99, medication: SEMA, site: 'unknown' });
    await addPrescription({ type: SEMA, lotNumber: 'pre-existing' });
    await saveProfile({ startWeight: 200 });

    await seedDemoData();

    const entries = await getAllEntries();
    expect(entries.some((e) => e.weightLbs === 999)).toBe(false);
    expect(entries.some((e) => e.amountMg === 99)).toBe(false);
    const prescriptions = await getAllPrescriptions();
    expect(prescriptions.some((p) => p.lotNumber === 'pre-existing')).toBe(false);
    expect(await getProfile()).toBeUndefined();
  });
});

describe('clearDemoData', () => {
  it('removes everything seeded by seedDemoData', async () => {
    await seedDemoData();
    expect((await getAllEntries()).length).toBeGreaterThan(0);
    expect((await getAllPrescriptions()).length).toBeGreaterThan(0);

    await clearDemoData();

    expect(await getAllEntries()).toEqual([]);
    expect(await getAllPrescriptions()).toEqual([]);
    expect(await getProfile()).toBeUndefined();
  });

  it('is a no-op when there is no data to clear', async () => {
    await expect(clearDemoData()).resolves.toBeUndefined();
    expect(await getAllEntries()).toEqual([]);
  });
});

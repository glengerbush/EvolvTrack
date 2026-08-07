import { addEntry, addPrescription, clearAllData } from '$lib/domain/health-data-storage';
import type { IsoDate } from '$lib/domain/types';
import { addDays, asIsoDate, dateKeyFromDate, enumerateDateKeys, localDateKey } from '$lib/utils/dateKeys';

function iso(literal: string): IsoDate {
  const parsed = asIsoDate(literal);
  if (!parsed) throw new Error(`Invalid hardcoded ISO date in seed data: ${literal}`);
  return parsed;
}

const MEDICATION = 'Semaglutide (Ozempic / Wegovy)';
const DOSE_SITES = ['Thigh (Right)', 'Abdomen (Left)', 'Thigh (Left)', 'Abdomen (Right)'];
const SYMPTOM_SETS = [
  ['Nausea'],
  ['Headache'],
  ['Nausea', 'Constipation'],
  ['Abdominal pain'],
];

function addCalendarMonths(dateKey: IsoDate, months: number): IsoDate {
  const [year, month, day] = dateKey.split('-').map(Number);
  const target = new Date(year, month - 1 + months, 1);
  const lastDayOfTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDayOfTargetMonth));
  return dateKeyFromDate(target);
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function confirmedAtForDate(dateKey: IsoDate): string {
  return `${dateKey}T14:00:00.000Z`;
}

function weightForDay(dayIndex: number, hasSymptoms: boolean): number {
  const weeklyVariation = [0.1, -0.1, 0.2, 0, -0.2, 0.1, -0.1][dayIndex % 7];
  const symptomBump = hasSymptoms ? 0.3 : 0;
  return roundToTenth(186.4 - dayIndex * 0.17 + weeklyVariation + symptomBump);
}

export async function seedDemoData(): Promise<void> {
  await clearAllData();

  const today = localDateKey();
  const startDate = addCalendarMonths(today, -1);
  const dates = enumerateDateKeys(startDate, today);
  const doseDates: IsoDate[] = [];

  for (let date: IsoDate = today; date >= startDate; date = addDays(date, -7)) {
    doseDates.unshift(date);
  }

  const symptomsByDate = new Map<IsoDate, string[]>();
  doseDates.forEach((doseDate, index) => {
    const symptomDate = addDays(doseDate, 2);
    if (symptomDate <= today) {
      symptomsByDate.set(symptomDate, SYMPTOM_SETS[index % SYMPTOM_SETS.length]);
    }
  });

  // ── Health entries (one record per row) ─────────────────────────────────────
  // Each date gets a weigh-in entry; dose dates merge the dose onto that same
  // row (matching the old combined view) so a dosing day reads as one row.
  const doseByDate = new Map<IsoDate, { amountMg: number; site: string }>();
  doseDates.forEach((date, index) => {
    doseByDate.set(date, { amountMg: index < 2 ? 2.5 : 5, site: DOSE_SITES[index % DOSE_SITES.length] });
  });

  await Promise.all(dates.map((date, index) => {
    const symptoms = symptomsByDate.get(date) ?? [];
    const dose = doseByDate.get(date);
    return addEntry({
      date,
      weightLbs: weightForDay(index, symptoms.length > 0),
      wellness: symptoms.length > 0 ? 2 : index % 6 === 0 ? 4 : 5,
      symptoms,
      ...(dose
        ? {
            amountMg: dose.amountMg,
            site: dose.site,
            medication: MEDICATION,
            ...(date === today ? { planned: true } : { confirmedAt: confirmedAtForDate(date) }),
          }
        : {}),
    });
  }));

  // ── Prescriptions (vials) ─────────────────────────────────────────────────
  await addPrescription({ type: 'Semaglutide (Ozempic / Wegovy)',     concentrationMgMl: 5,  additive: 'B12', vialMl: 2, prescribedDoseMg: 2.5, dosesLeft: 0,   costUsd: 179.83, pharmacy: 'Greenwich', compoundDate: addDays(today, -240), bud: addDays(today, -60),  lotNumber: '031225-04', status: 'warning'  });
  await addPrescription({ type: 'Semaglutide (Ozempic / Wegovy)',     concentrationMgMl: 10, additive: 'B12', vialMl: 2, prescribedDoseMg: 5,   dosesLeft: 0,   costUsd: 193.03, pharmacy: 'Greenwich', compoundDate: addDays(today, -120), bud: addDays(today, -10),  lotNumber: '052025-02', status: 'warning'  });
  await addPrescription({ type: 'Semaglutide (Ozempic / Wegovy)',     concentrationMgMl: 15, additive: 'B12', vialMl: 2, prescribedDoseMg: 5,   dosesLeft: 3.8, costUsd: 193.03, pharmacy: 'Greenwich', compoundDate: addDays(today, -21),  bud: addDays(today, 159),  lotNumber: '082525-11', status: 'active'   });
  await addPrescription({ type: 'Tirzepatide (Mounjaro / Zepbound)', concentrationMgMl: 20, additive: 'B6',  vialMl: 3, prescribedDoseMg: 10,  dosesLeft: 5,   costUsd: 193.03, pharmacy: 'BPI',       compoundDate: iso('2025-08-25'), bud: iso('2026-02-25'), lotNumber: '082525-12', status: 'neutral'  });
  await addPrescription({ type: 'Tirzepatide (Mounjaro / Zepbound)', concentrationMgMl: 20, additive: 'B6',  vialMl: 3, prescribedDoseMg: 12,  dosesLeft: 4,   costUsd: 141.33, pharmacy: 'BPI',       compoundDate: iso('2025-09-15'), bud: iso('2026-03-15'), lotNumber: '091525-03', status: 'neutral'  });
  await addPrescription({ type: 'Tirzepatide (Mounjaro / Zepbound)', concentrationMgMl: 20, additive: 'B6',  vialMl: 3, prescribedDoseMg: 15,  dosesLeft: 4,   costUsd: 141.33, pharmacy: 'BPI',       compoundDate: iso('2025-09-15'), bud: iso('2026-03-15'), lotNumber: '091525-07', status: 'neutral'  });
}

export async function clearDemoData(): Promise<void> {
  await clearAllData();
}

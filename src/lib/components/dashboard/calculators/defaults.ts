import { get } from 'svelte/store';
import { medicationRows, type MedicationInputRow } from '$lib/stores/medicationStore';

export function getMedicationRowsSnapshot() {
  return get(medicationRows);
}

export function getActiveVial(rows: MedicationInputRow[] = getMedicationRowsSnapshot()) {
  return rows.find((row) => row.status === 'active') ?? rows[0] ?? null;
}

export function getActiveAndNextVials(rows: MedicationInputRow[] = getMedicationRowsSnapshot()) {
  const activeIndex = rows.findIndex((row) => row.status === 'active');
  const currentIndex = activeIndex >= 0 ? activeIndex : 0;
  const currentVial = rows[currentIndex] ?? null;
  const nextVial = rows[currentIndex + 1] ?? currentVial;

  return { currentVial, nextVial };
}

export function u100UnitsForDose(dosageMg: number, concentrationMgPerMl: number) {
  return concentrationMgPerMl > 0 ? (dosageMg / concentrationMgPerMl) * 100 : 0;
}

export function clampSyringeUnits(units: number, valid = true) {
  return Math.max(0, Math.min(100, valid ? units : 0));
}

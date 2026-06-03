import { derived } from 'svelte/store';
import { fromLiveQuery } from '$lib/db/liveQuery';
import { getAllInjections, getAllPrescriptions } from '$lib/domain/repo';
import type { InjectionEntry, Medication, Prescription, PrescriptionStatus } from '$lib/domain/types';
import { computeVialLevels, type DoseEvent, type VialLevel } from '$lib/utils/vialLevels';

export const rawPrescriptions = fromLiveQuery(
  getAllPrescriptions,
  [] as Prescription[],
);

export const rawInjections = fromLiveQuery(
  getAllInjections,
  [] as InjectionEntry[],
);

/**
 * Whether an injection actually drew product from a vial. Planned-but-not-taken
 * and skipped doses don't consume anything, so they're excluded from vial math.
 */
export function isConsumingDose(injection: InjectionEntry): boolean {
  return !injection.skipped && !injection.planned && injection.amountMg > 0;
}

function toDoseEvent(injection: InjectionEntry): DoseEvent {
  return {
    medication: injection.medication || '',
    amountMg: injection.amountMg,
    date: injection.date,
    createdAt: injection.createdAt,
  };
}

export type MedicationInputRow = {
  id: number;
  dbId: string;
  type: Medication | '';
  cost: number;
  pharmacy: string;
  concentrationMg: number;
  additive: string;
  mlInVial: number;
  prescribedDosage: number;
  dosesLeft: number;
  /** Manual correction (mg) to this vial's computed consumption; see vialLevels. */
  manualMgUsed?: number;
  status: PrescriptionStatus;
  archived: boolean;
};

/**
 * Computed level of every vial, keyed by prescription id. Reactive to both the
 * vials and the doses logged against them (compound-date FIFO; see
 * `computeVialLevels`). This is the source of truth for "doses/mg left" — the
 * stored `dosesLeft` is only a fallback for vials with incomplete specs.
 */
export const vialLevels = derived<
  [typeof rawPrescriptions, typeof rawInjections],
  Map<string, VialLevel>
>([rawPrescriptions, rawInjections], ([$prescriptions, $injections]) =>
  computeVialLevels(
    $prescriptions.map((p) => ({
      id: p.id,
      medication: p.type ?? '',
      concentrationMgMl: p.concentrationMgMl,
      vialMl: p.vialMl,
      prescribedDoseMg: p.prescribedDoseMg,
      compoundDate: p.compoundDate,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      manualMgUsed: p.manualMgUsed,
    })),
    $injections.filter(isConsumingDose).map(toDoseEvent),
  ),
);

export const medicationRows = derived(
  [rawPrescriptions, vialLevels],
  ([$prescriptions, $levels]): MedicationInputRow[] =>
    $prescriptions.map((p, i) => {
      const level = $levels.get(p.id);
      return {
        id: i + 1,
        dbId: p.id,
        type: p.type ?? '',
        cost: p.costUsd ?? 0,
        pharmacy: p.pharmacy ?? '',
        concentrationMg: p.concentrationMgMl ?? 0,
        additive: p.additive ?? '',
        mlInVial: p.vialMl ?? 0,
        prescribedDosage: p.prescribedDoseMg ?? 0,
        // Computed doses-left (falls back to the legacy stored value only when
        // specs are too incomplete to compute a level).
        dosesLeft: level?.dosesLeft ?? p.dosesLeft ?? 0,
        manualMgUsed: p.manualMgUsed,
        status: p.status ?? 'neutral',
        archived: p.archived ?? false,
      };
    }),
);

export const activeVial = derived(medicationRows, ($rows) =>
  $rows.find((r) => r.status === 'active') ?? null,
);

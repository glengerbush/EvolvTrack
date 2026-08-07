import { derived } from 'svelte/store';
import { fromLiveQuery } from '$lib/db/liveQuery';
import { getAllEntries, getAllPrescriptions } from '$lib/domain/health-data-storage';
import type { HealthEntry, Medication, Prescription, PrescriptionStatus } from '$lib/domain/types';
import {
  attributeVials,
  computeVialLevels,
  type DoseEvent,
  type VialAttribution,
  type VialLevel,
  type VialSpec,
} from '$lib/utils/vialLevels';

export const rawPrescriptions = fromLiveQuery(
  getAllPrescriptions,
  [] as Prescription[],
);

export const rawEntries = fromLiveQuery(
  getAllEntries,
  [] as HealthEntry[],
);

/**
 * Whether an entry's dose actually drew product from a vial. Planned-but-not-
 * taken, skipped, and weigh-in-only rows don't consume anything, so they're
 * excluded from vial math.
 */
export function isConsumingDose(entry: HealthEntry): boolean {
  return !entry.skipped && !entry.planned && entry.amountMg != null && entry.amountMg > 0;
}

function toDoseEvent(entry: HealthEntry): DoseEvent {
  return {
    id: entry.id,
    medication: entry.medication || '',
    amountMg: entry.amountMg as number,
    date: entry.date,
    createdAt: entry.createdAt,
    prescriptionId: entry.prescriptionId,
  };
}

function toVialSpec(p: Prescription): VialSpec {
  return {
    id: p.id,
    medication: p.type ?? '',
    concentrationMgMl: p.concentrationMgMl,
    vialMl: p.vialMl,
    prescribedDoseMg: p.prescribedDoseMg,
    compoundDate: p.compoundDate,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt,
    manualMgUsed: p.manualMgUsed,
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
 * Computed level of every vial, keyed by prescription id. Each dose drains
 * exactly its stored vial attribution (see `computeVialLevels`); reactive to the
 * vials and the doses. This is the source of truth for "doses/mg left" — the
 * stored `dosesLeft` is only a fallback for vials with incomplete specs.
 */
export const vialLevels = derived<
  [typeof rawPrescriptions, typeof rawEntries],
  Map<string, VialLevel>
>([rawPrescriptions, rawEntries], ([$prescriptions, $entries]) =>
  computeVialLevels(
    $prescriptions.map(toVialSpec),
    $entries.filter(isConsumingDose).map(toDoseEvent),
  ),
);

/**
 * The vial each consuming dose draws from, keyed by entry id — stored override
 * or FIFO start vial (see `attributeVials`). Reactive to vials + doses.
 */
const vialAttribution = derived<
  [typeof rawPrescriptions, typeof rawEntries],
  Map<string, VialAttribution>
>([rawPrescriptions, rawEntries], ([$prescriptions, $entries]) =>
  attributeVials($prescriptions.map(toVialSpec), $entries.filter(isConsumingDose).map(toDoseEvent)),
);

/**
 * Effective vial id per consuming dose (stored OR auto). The inputs table reads
 * this for the dose chip so the vial number always shows, regardless of whether
 * the local row's stored attribution has synced yet.
 */
export const vialByEntryId = derived(vialAttribution, ($attr) => {
  const out = new Map<string, string>();
  for (const [id, a] of $attr) out.set(id, a.vialId);
  return out;
});

/**
 * Only the doses still needing a permanent attribution (auto, not yet frozen).
 * The inputs table persists these as `prescriptionId`.
 */
export const autoVialByEntryId = derived(vialAttribution, ($attr) => {
  const out = new Map<string, string>();
  for (const [id, a] of $attr) if (a.auto) out.set(id, a.vialId);
  return out;
});

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

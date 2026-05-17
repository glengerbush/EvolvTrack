import { derived } from 'svelte/store';
import { fromLiveQuery } from '$lib/db/liveQuery';
import { getAllPrescriptions } from '$lib/domain/repo';
import type { Medication, Prescription, PrescriptionStatus } from '$lib/domain/types';

export const rawPrescriptions = fromLiveQuery(
  getAllPrescriptions,
  [] as Prescription[],
);

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
  status: PrescriptionStatus;
};

export const medicationRows = fromLiveQuery(async () => {
  const prescriptions = await getAllPrescriptions();
  return prescriptions.map(
    (p, i): MedicationInputRow => ({
      id: i + 1,
      dbId: p.id,
      type: p.type ?? '',
      cost: p.costUsd ?? 0,
      pharmacy: p.pharmacy ?? '',
      concentrationMg: p.concentrationMgMl ?? 0,
      additive: p.additive ?? '',
      mlInVial: p.vialMl ?? 0,
      prescribedDosage: p.prescribedDoseMg ?? 0,
      dosesLeft: p.dosesLeft ?? 0,
      status: p.status ?? 'neutral',
    }),
  );
}, [] as MedicationInputRow[]);

export const activeVial = derived(medicationRows, ($rows) =>
  $rows.find((r) => r.status === 'active') ?? null,
);

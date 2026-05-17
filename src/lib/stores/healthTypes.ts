import type { IsoDate } from '$lib/domain/types';
import type { SystemDrugAmount } from '$lib/utils/pharmacokinetics';

export type HealthSystemAmount = SystemDrugAmount & {
  color: string;
  initial: string;
};

export type HealthInputRow = {
  weightId?: string;
  injectionId?: string;
  day: string;
  date: IsoDate;
  system: string;
  systemAmounts: HealthSystemAmount[];
  dose: string;
  dosePlanned: boolean;
  doseConfirmedAt?: string;
  doseSkipped: boolean;
  medication: string;
  weight: string;
  wellness: string;
  loss: string;
  symptoms: string[];
  shotLocation: string;
  notes: string;
};

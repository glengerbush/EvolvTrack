import { addEntry, getProfile, saveProfile, updateEntry } from '$lib/domain/health-data-storage';
import type { HealthColKey, IsoDate, IsoDateTime, Medication } from '$lib/domain/types';
import { localDateKey } from '$lib/utils/dateKeys';

export type HealthInputRowSaveInput = {
  entryId?: string;
  date: IsoDate;
  weightLbs?: number;
  wellness?: number;
  symptoms: string[];
  notes?: string;
  doseMg?: number;
  dosePlanned?: boolean;
  doseConfirmedAt?: IsoDateTime;
  doseSkipped?: boolean;
  medication?: Medication | '';
  shotLocation?: string;
  prescriptionId?: string;
};

export type SavedHealthInputRow = {
  entryId?: string;
  medication?: Medication | '';
  dosePlanned?: boolean;
  doseConfirmedAt?: IsoDateTime;
  doseSkipped?: boolean;
  prescriptionId?: string;
};

export type SaveInputRowsOptions = {
  defaultMedication?: Medication | '';
  today?: IsoDate;
};

export type InputTableSettings = {
  columnOrder?: HealthColKey[];
  hiddenColumns?: HealthColKey[];
};

// One row = one HealthEntry. No weight/injection split, so editing a row only
// ever touches its own record — a note (or anything else) can't leak onto a
// sibling row that merely shares the date.
async function saveInputRow(
  row: HealthInputRowSaveInput,
  options: Required<SaveInputRowsOptions>,
): Promise<SavedHealthInputRow> {
  const hasDose = row.doseMg != null && Number.isFinite(row.doseMg);

  const medication = hasDose ? row.medication || options.defaultMedication : '';
  const doseSkipped = hasDose && row.doseSkipped === true;
  const explicitlyConfirmed = row.dosePlanned === false && row.doseConfirmedAt != null;
  const dosePlanned =
    hasDose && !doseSkipped && !explicitlyConfirmed && (row.dosePlanned === true || row.date > options.today);
  const doseConfirmedAt = !hasDose || dosePlanned || doseSkipped ? undefined : row.doseConfirmedAt;

  const data = {
    date: row.date,
    weightLbs: row.weightLbs,
    wellness: row.wellness,
    symptoms: row.symptoms,
    notes: row.notes,
    amountMg: hasDose ? (row.doseMg as number) : undefined,
    medication: hasDose ? medication : undefined,
    site: hasDose ? row.shotLocation ?? '' : undefined,
    prescriptionId: hasDose ? row.prescriptionId || undefined : undefined,
    planned: hasDose ? dosePlanned : undefined,
    confirmedAt: doseConfirmedAt,
    skipped: hasDose ? doseSkipped : undefined,
  };

  let entryId = row.entryId;
  if (entryId) {
    await updateEntry(entryId, data);
  } else {
    const created = await addEntry(data);
    entryId = created.id;
  }

  return {
    entryId,
    medication: hasDose ? medication : undefined,
    dosePlanned: hasDose ? dosePlanned : undefined,
    doseConfirmedAt,
    doseSkipped: hasDose ? doseSkipped : undefined,
    prescriptionId: hasDose ? row.prescriptionId || undefined : undefined,
  };
}

export async function saveInputRows(
  rows: HealthInputRowSaveInput[],
  options: SaveInputRowsOptions = {},
): Promise<SavedHealthInputRow[]> {
  const resolvedOptions: Required<SaveInputRowsOptions> = {
    defaultMedication: options.defaultMedication ?? '',
    today: options.today ?? localDateKey(),
  };

  return Promise.all(rows.map((row) => saveInputRow(row, resolvedOptions)));
}

export async function getInputTableSettings(): Promise<InputTableSettings> {
  const profile = await getProfile();

  return {
    columnOrder: profile?.healthColOrder,
    hiddenColumns: profile?.healthHiddenCols,
  };
}

export async function saveInputTableSettings(settings: InputTableSettings): Promise<void> {
  await saveProfile({
    healthColOrder: settings.columnOrder,
    healthHiddenCols: settings.hiddenColumns,
  });
}

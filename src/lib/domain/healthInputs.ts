import {
  addInjection,
  addWeight,
  getProfile,
  saveProfile,
  updateInjection,
  updateWeight,
} from '$lib/domain/repo';
import type { HealthColKey, IsoDate, IsoDateTime, Medication } from '$lib/domain/types';
import { localDateKey } from '$lib/utils/dateKeys';

export type HealthInputRowSaveInput = {
  weightId?: string;
  injectionId?: string;
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
};

export type SavedHealthInputRow = {
  weightId?: string;
  injectionId?: string;
  injectionSaved: boolean;
  medication?: Medication | '';
  dosePlanned?: boolean;
  doseConfirmedAt?: IsoDateTime;
  doseSkipped?: boolean;
};

export type SaveInputRowsOptions = {
  defaultMedication?: Medication | '';
  today?: IsoDate;
};

export type InputTableSettings = {
  columnOrder?: HealthColKey[];
  hiddenColumns?: HealthColKey[];
};

function hasWeightData(row: HealthInputRowSaveInput): boolean {
  return (
    row.weightLbs != null ||
    row.wellness != null ||
    row.symptoms.length > 0 ||
    row.notes != null
  );
}

async function saveInputRow(
  row: HealthInputRowSaveInput,
  options: Required<SaveInputRowsOptions>,
): Promise<SavedHealthInputRow> {
  const { weightId: initialWeightId, injectionId: initialInjectionId } = row;

  const weightOp: Promise<string | undefined> = hasWeightData(row)
    ? (async () => {
        const weightData = {
          date: row.date,
          weightLbs: row.weightLbs,
          wellness: row.wellness,
          symptoms: row.symptoms,
          notes: row.notes,
        };
        if (initialWeightId) {
          await updateWeight(initialWeightId, weightData);
          return initialWeightId;
        }
        const entry = await addWeight(weightData);
        return entry.id;
      })()
    : Promise.resolve(initialWeightId);

  if (row.doseMg == null || !Number.isFinite(row.doseMg)) {
    const weightId = await weightOp;
    return { weightId, injectionId: initialInjectionId, injectionSaved: false };
  }

  const medication = row.medication || options.defaultMedication;
  const doseSkipped = row.doseSkipped === true;
  const explicitlyConfirmed = row.dosePlanned === false && row.doseConfirmedAt != null;
  const dosePlanned = !doseSkipped && !explicitlyConfirmed && (row.dosePlanned === true || row.date > options.today);
  const doseConfirmedAt = dosePlanned || doseSkipped ? undefined : row.doseConfirmedAt;
  const injectionData = {
    date: row.date,
    amountMg: row.doseMg,
    medication,
    site: row.shotLocation ?? '',
    notes: row.notes,
    planned: dosePlanned,
    confirmedAt: doseConfirmedAt,
    skipped: doseSkipped,
  };

  const injectionOp: Promise<string> = initialInjectionId
    ? updateInjection(initialInjectionId, injectionData).then(() => initialInjectionId)
    : addInjection({ ...injectionData, symptoms: [] }).then((entry) => entry.id);

  const [weightId, injectionId] = await Promise.all([weightOp, injectionOp]);

  return {
    weightId,
    injectionId,
    injectionSaved: true,
    medication,
    dosePlanned,
    doseConfirmedAt,
    doseSkipped,
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

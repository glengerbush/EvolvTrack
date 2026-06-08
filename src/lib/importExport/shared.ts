import { nanoid } from 'nanoid';
import type { HealthEntry, IsoDate, Medication, Prescription, ProfileSettings } from '$lib/domain/types';
import { isMedication } from '$lib/domain/types';
import { asIsoDate } from '$lib/utils/dateKeys';

export type ImportMode = 'merge' | 'replace';

export type ImportData = {
  entries: HealthEntry[];
  prescriptions: Prescription[];
  profile?: ProfileSettings;
};

export type ImportSource =
  | 'EvolvTrack backup'
  | 'EvolvTrack spreadsheet'
  | 'External JSON'
  | 'External CSV'
  | 'External spreadsheet';

export type ImportParseResult = {
  source: ImportSource;
  sourceDetail?: string;
  data: ImportData;
  warnings: string[];
};

export type ImportApplyResult = ImportParseResult & {
  mode: ImportMode;
};

export const EMPTY_IMPORT_DATA: ImportData = {
  entries: [],
  prescriptions: [],
};

const LBS_PER_KG = 2.2046226218;

export function nowIso() {
  return new Date().toISOString();
}

export function cleanString(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

export function cleanOptionalString(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  return cleaned || undefined;
}

export function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const cleaned = cleanString(value)
    .replace(/[$,]/g, '')
    .replace(/\b(mg|ml|lbs?|kg|units?)\b/gi, '')
    .trim();
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const cleaned = cleanString(value).toLowerCase();
  if (!cleaned) return undefined;
  if (['true', 'yes', 'y', '1', 'planned', 'scheduled'].includes(cleaned)) return true;
  if (['false', 'no', 'n', '0', 'confirmed', 'taken', 'complete', 'completed'].includes(cleaned)) return false;
  return undefined;
}

export function parseDateKey(value: unknown): IsoDate | undefined {
  // Each branch returns either undefined or a string already validated to match
  // YYYY-MM-DD shape; route through asIsoDate so the brand is applied and
  // overflow values (e.g. `2025-13-01` from a fishy spreadsheet) still get
  // filtered out.
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return asIsoDate(value.toISOString().slice(0, 10)) ?? undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return asIsoDate(new Date(excelEpoch + value * 86400000).toISOString().slice(0, 10)) ?? undefined;
  }

  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const iso = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return asIsoDate(`${iso[1]}-${iso[2]}-${iso[3]}`) ?? undefined;

  const slashDate = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashDate) {
    const month = slashDate[1].padStart(2, '0');
    const day = slashDate[2].padStart(2, '0');
    const year = slashDate[3].length === 2 ? `20${slashDate[3]}` : slashDate[3];
    return asIsoDate(`${year}-${month}-${day}`) ?? undefined;
  }

  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return asIsoDate(parsed.toISOString().slice(0, 10)) ?? undefined;
}

export function parseDateTime(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }
  return cleanString(value)
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeHeader(value: unknown): string {
  return cleanString(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function pickField(row: Record<string, unknown>, candidates: string[]): unknown {
  for (const candidate of candidates) {
    if (candidate in row) return row[candidate];
  }
  const normalized = new Map(Object.keys(row).map((key) => [normalizeHeader(key), key]));
  for (const candidate of candidates) {
    const key = normalized.get(normalizeHeader(candidate));
    if (key) return row[key];
  }
  return undefined;
}

export function mapObjectByNormalizedHeaders(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeHeader(key)] = value;
  }
  return normalized;
}

export function normalizeMedication(value: unknown): Medication | '' {
  const medication = cleanString(value);
  if (!medication) return '';
  if (isMedication(medication)) return medication;

  const normalized = medication.toLowerCase();
  if (/semaglutide|ozempic|wegovy|rybelsus/.test(normalized)) return 'Semaglutide (Ozempic / Wegovy)';
  if (/tirzepatide|mounjaro|zepbound/.test(normalized)) return 'Tirzepatide (Mounjaro / Zepbound)';
  if (/dulaglutide|trulicity/.test(normalized)) return 'Dulaglutide (Trulicity)';
  if (/liraglutide|victoza|saxenda/.test(normalized)) return 'Liraglutide (Victoza / Saxenda)';
  if (/retatrutide/.test(normalized)) return 'Retatrutide';

  return '';
}

export function weightToStoredLbs(value: unknown, unitHint?: string): number | undefined {
  const parsed = parseNumber(value);
  if (parsed == null) return undefined;
  const hint = cleanString(unitHint).toLowerCase();
  return hint.includes('kg') ? parsed * LBS_PER_KG : parsed;
}

export function weightFromStoredLbs(value: number | undefined, unit: string | undefined): number | '' {
  if (value == null || !Number.isFinite(value)) return '';
  if (unit === 'kg') return round(value / LBS_PER_KG, 2);
  return round(value, 2);
}

export function round(value: number, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// One unified row per import record. Dose fields are only set when a dose is
// present, so a weigh-in-only row stays dose-free (and vice versa).
export function makeHealthEntry(input: {
  id?: unknown;
  date: IsoDate;
  weightLbs?: number;
  wellness?: number;
  symptoms?: string[];
  notes?: string;
  amountMg?: number;
  medication?: unknown;
  site?: unknown;
  planned?: unknown;
  confirmedAt?: unknown;
  prescriptionId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}): HealthEntry {
  const timestamp = nowIso();
  const hasDose = input.amountMg != null && Number.isFinite(input.amountMg) && input.amountMg > 0;
  return {
    id: cleanString(input.id) || nanoid(),
    date: input.date,
    weightLbs: input.weightLbs,
    wellness: input.wellness,
    symptoms: input.symptoms ?? [],
    notes: input.notes,
    amountMg: hasDose ? input.amountMg : undefined,
    medication: hasDose ? normalizeMedication(input.medication) : undefined,
    site: hasDose ? cleanString(input.site) : undefined,
    prescriptionId: hasDose ? cleanString(input.prescriptionId) || undefined : undefined,
    planned: hasDose ? parseBoolean(input.planned) : undefined,
    confirmedAt: hasDose ? parseDateTime(input.confirmedAt) : undefined,
    createdAt: parseDateTime(input.createdAt) ?? timestamp,
    updatedAt: parseDateTime(input.updatedAt) ?? timestamp,
  };
}

export function makePrescription(input: {
  id?: unknown;
  type?: unknown;
  compoundDate?: unknown;
  refillDate?: unknown;
  bud?: unknown;
  lotNumber?: unknown;
  concentrationMgMl?: unknown;
  vialMl?: unknown;
  prescribedDoseMg?: unknown;
  dosesLeft?: unknown;
  costUsd?: unknown;
  pharmacy?: unknown;
  additive?: unknown;
  status?: unknown;
  sortOrder?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}): Prescription {
  const timestamp = nowIso();
  const status = cleanString(input.status).toLowerCase();
  return {
    id: cleanString(input.id) || nanoid(),
    type: normalizeMedication(input.type) || undefined,
    compoundDate: parseDateKey(input.compoundDate),
    refillDate: parseDateKey(input.refillDate),
    bud: parseDateKey(input.bud),
    lotNumber: cleanOptionalString(input.lotNumber),
    concentrationMgMl: parseNumber(input.concentrationMgMl),
    vialMl: parseNumber(input.vialMl),
    prescribedDoseMg: parseNumber(input.prescribedDoseMg),
    dosesLeft: parseNumber(input.dosesLeft),
    costUsd: parseNumber(input.costUsd),
    pharmacy: cleanOptionalString(input.pharmacy),
    additive: cleanOptionalString(input.additive),
    status: status === 'warning' || status === 'active' || status === 'neutral' ? status : undefined,
    sortOrder: parseNumber(input.sortOrder),
    createdAt: parseDateTime(input.createdAt) ?? timestamp,
    updatedAt: parseDateTime(input.updatedAt) ?? timestamp,
  };
}

export function mergeWarnings(...groups: string[][]) {
  return [...new Set(groups.flat())];
}

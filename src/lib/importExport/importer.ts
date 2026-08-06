import { db } from '$lib/db/schema';
import { emitHealthChange, enqueueImportedRows } from '$lib/domain/repo';
import { setStartWeightIfUnset } from '$lib/stores/progressStore';
import { hydrateSymptomStoresFromProfile } from '$lib/stores/symptomStore';
import {
  BACKUP_FORMAT_VERSION,
  isEvolvTrackBackupEnvelope,
  parseBackupPayload,
} from '$lib/importExport/backup';
import {
  SPREADSHEET_FORMAT_VERSION,
  getSpreadsheetMetadata,
  isEvolvTrackSpreadsheet,
  readSpreadsheetFile,
  workbookSheet,
  type SpreadsheetCellValue,
  type SpreadsheetSheet,
  type SpreadsheetWorkbook,
} from '$lib/importExport/spreadsheet';
import {
  cleanOptionalString,
  cleanString,
  EMPTY_IMPORT_DATA,
  makeHealthEntry,
  makePrescription,
  mapObjectByNormalizedHeaders,
  mergeWarnings,
  normalizeHeader,
  normalizeMedication,
  nowIso,
  parseBoolean,
  parseDateKey,
  parseList,
  parseNumber,
  pickField,
  type ImportApplyResult,
  type ImportData,
  type ImportMode,
  type ImportParseResult,
  weightToStoredLbs,
} from '$lib/importExport/shared';
import type {
  DosageColKey,
  HealthColKey,
  HealthEntry,
  Prescription,
  ProfileSettings,
  VialColKey,
  WeightUnit,
} from '$lib/domain/types';
import { DOSAGE_COL_KEYS, HEALTH_COL_KEYS, VIAL_COL_KEYS, WEIGHT_UNITS } from '$lib/domain/types';
import { canonicalDomain } from '$lib/domain/canonical-domain';
import { THEME_NAMES, type ThemeName } from '$lib/theme/dashboardTheme';

type ObjectTable = {
  name: string;
  headers: string[];
  rows: Record<string, unknown>[];
};

export const EXTERNAL_IMPORT_TARGETS = [
  { app: 'GLPal', formats: 'CSV and JSON', support: 'targeted' },
  { app: 'Gilly', formats: 'CSV', support: 'targeted' },
  { app: 'Shotsy', formats: 'CSV and JSON-style exports', support: 'targeted' },
  { app: 'NewArc', formats: 'CSV', support: 'best-effort' },
  { app: 'Pepta', formats: 'JSON', support: 'best-effort' },
  { app: 'Kilost', formats: 'CSV', support: 'best-effort' },
  { app: 'Peptide Tracker', formats: 'CSV and TXT reports', support: 'best-effort' },
  { app: 'Velto', formats: 'CSV', support: 'best-effort' },
  { app: 'Pokii', formats: 'CSV and Shotsy JSON migrations', support: 'best-effort' },
  { app: 'Phaze', formats: 'JSON', support: 'best-effort' },
  { app: 'GLYRA', formats: 'export summaries', support: 'best-effort' },
  { app: 'ShotClock', formats: 'reports', support: 'best-effort' },
] as const;

const DATE_FIELDS = ['date', 'shot date', 'injection date', 'dose date', 'taken at', 'logged at', 'time', 'timestamp'];
const WEIGHT_FIELDS = ['weight', 'body weight', 'current weight', 'weight lbs', 'weight kg'];
const WELLNESS_FIELDS = ['wellness', 'wellness score', 'mood', 'feeling', 'check in score'];
const SYMPTOM_FIELDS = ['symptoms', 'side effects', 'side effect', 'effects', 'side effect log'];
const DOSE_FIELDS = ['dose', 'dose mg', 'dosage', 'amount', 'amount mg', 'quantity', 'units'];
const MEDICATION_FIELDS = ['medication', 'medicine', 'drug', 'peptide', 'compound', 'glp 1', 'type'];
const SITE_FIELDS = ['shot location', 'injection site', 'site', 'location', 'body site'];
const STATUS_FIELDS = ['status', 'planned', 'confirmed', 'taken', 'completed'];
const NOTE_FIELDS = ['notes', 'note', 'comments', 'comment', 'reflection', 'details'];
const CONFIRMED_FIELDS = ['confirmed at', 'taken at', 'completed at'];
const WEIGHT_ID_FIELDS = ['weight id', '_weightid', 'weightid'];
const INJECTION_ID_FIELDS = ['injection id', '_injectionid', 'injectionid', 'shot id'];
const PRESCRIPTION_ID_FIELDS = ['prescription id', '_prescriptionid', 'prescriptionid', 'medication id'];
const NO_COMPATIBLE_IMPORT_DATA = 'No compatible health, injection, medication, or settings rows were found in that file.';


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tableFromRows(name: string, rows: SpreadsheetCellValue[][]): ObjectTable | null {
  const headerIndex = rows.findIndex((row) => row.filter((cell) => cleanString(cell)).length >= 2);
  if (headerIndex < 0) return null;

  const headers = rows[headerIndex].map((cell) => cleanString(cell));
  const normalizedHeaders = headers.map(normalizeHeader);
  const dataRows = rows.slice(headerIndex + 1);
  const objects: Record<string, unknown>[] = [];

  for (const row of dataRows) {
    if (!row.some((cell) => cleanString(cell))) continue;
    const object: Record<string, unknown> = {};
    for (let index = 0; index < normalizedHeaders.length; index += 1) {
      const header = normalizedHeaders[index];
      if (!header) continue;
      object[header] = row[index];
    }
    objects.push(object);
  }

  return { name, headers, rows: objects };
}

function tableFromSheet(sheet: SpreadsheetSheet | undefined): ObjectTable | null {
  if (!sheet) return null;
  return tableFromRows(sheet.name, sheet.rows);
}

function detectWeightUnit(headers: string[]): WeightUnit | undefined {
  const weightHeader = headers.find((header) => /weight/i.test(header));
  if (!weightHeader) return undefined;
  return /kg/i.test(weightHeader) ? 'kg' : 'lbs';
}

function hasAnyField(row: Record<string, unknown>, fields: string[]) {
  return fields.some((field) => pickField(row, [field]) != null);
}

function classifyTable(table: ObjectTable) {
  const normalizedHeaders = table.headers.map(normalizeHeader).join(' ');
  if (/concentration|vial|bud|pharmacy|lot number|prescribed/.test(normalizedHeaders)) return 'prescription';
  if (/dose|dosage|injection|shot|weight|side effect|symptom/.test(normalizedHeaders)) return 'health';
  return 'unknown';
}

function detectExternalSource(fileName: string, tables: ObjectTable[], payloadHint = '') {
  const headers = tables.flatMap((table) => table.headers).join(' ');
  const haystack = `${fileName} ${headers} ${payloadHint}`.toLowerCase();
  const match = EXTERNAL_IMPORT_TARGETS.find((target) => haystack.includes(target.app.toLowerCase()));
  return match?.app;
}

function medicationWarning(rawMedication: unknown) {
  const cleaned = cleanString(rawMedication);
  if (!cleaned || normalizeMedication(cleaned)) return null;
  return `Unrecognized medication "${cleaned}" was imported without a medication value.`;
}

function parseHealthLikeTable(table: ObjectTable): { data: Pick<ImportData, 'entries'>; warnings: string[] } {
  const warnings: string[] = [];
  const entries = [];
  const unitHint = detectWeightUnit(table.headers);

  for (const rawRow of table.rows) {
    const row = mapObjectByNormalizedHeaders(rawRow);
    const date = parseDateKey(pickField(row, DATE_FIELDS));
    if (!date) continue;

    const rawMedication = pickField(row, MEDICATION_FIELDS);
    const warning = medicationWarning(rawMedication);
    if (warning) warnings.push(warning);

    const weightLbs = weightToStoredLbs(pickField(row, WEIGHT_FIELDS), unitHint);
    const wellness = parseNumber(pickField(row, WELLNESS_FIELDS));
    const symptoms = parseList(pickField(row, SYMPTOM_FIELDS));
    const notes = cleanOptionalString(pickField(row, NOTE_FIELDS));
    const doseMg = parseNumber(pickField(row, DOSE_FIELDS));
    const hasDose = doseMg != null && doseMg > 0;
    const hasAnyData =
      weightLbs != null ||
      wellness != null ||
      symptoms.length > 0 ||
      notes != null ||
      hasDose ||
      cleanString(pickField(row, WEIGHT_ID_FIELDS)) ||
      cleanString(pickField(row, INJECTION_ID_FIELDS));

    if (!hasAnyData) continue;

    // One row = one entry. A combined row carries both weigh-in and dose; a
    // weigh-in-only or dose-only row carries just its side.
    entries.push(
      makeHealthEntry({
        id: pickField(row, WEIGHT_ID_FIELDS) || pickField(row, INJECTION_ID_FIELDS),
        date,
        weightLbs,
        wellness,
        symptoms,
        notes,
        ...(hasDose
          ? {
              amountMg: doseMg,
              medication: rawMedication,
              site: pickField(row, SITE_FIELDS),
              planned: pickField(row, STATUS_FIELDS),
              confirmedAt: pickField(row, CONFIRMED_FIELDS),
            }
          : {}),
      }),
    );
  }

  return { data: { entries }, warnings: [...new Set(warnings)] };
}

function parsePrescriptionTable(table: ObjectTable): { prescriptions: Prescription[]; warnings: string[] } {
  const prescriptions: Prescription[] = [];
  const warnings: string[] = [];

  table.rows.forEach((rawRow, index) => {
    const row = mapObjectByNormalizedHeaders(rawRow);
    const rawMedication = pickField(row, MEDICATION_FIELDS);
    const warning = medicationWarning(rawMedication);
    if (warning) warnings.push(warning);

    const hasPrescriptionData = [
      rawMedication,
      pickField(row, ['concentration', 'concentration mg ml', 'concentration mg per ml']),
      pickField(row, ['ml in vial', 'vial ml', 'volume']),
      pickField(row, ['cost', 'cost usd']),
      pickField(row, ['pharmacy']),
    ].some((value) => cleanString(value));
    if (!hasPrescriptionData) return;

    prescriptions.push(makePrescription({
      id: pickField(row, PRESCRIPTION_ID_FIELDS),
      type: rawMedication,
      concentrationMgMl: pickField(row, ['concentration', 'concentration mg ml', 'concentration mg per ml']),
      additive: pickField(row, ['additive']),
      vialMl: pickField(row, ['ml in vial', 'vial ml', 'volume']),
      prescribedDoseMg: pickField(row, ['prescribed dosage', 'prescribed dosage mg', 'prescribed dose', 'dose']),
      dosesLeft: pickField(row, ['doses left', 'remaining doses']),
      compoundDate: pickField(row, ['compound date', 'compounded date']),
      refillDate: pickField(row, ['refill date']),
      bud: pickField(row, ['bud', 'beyond use date']),
      pharmacy: pickField(row, ['pharmacy']),
      lotNumber: pickField(row, ['lot number', 'lot']),
      costUsd: pickField(row, ['cost', 'cost usd']),
      status: pickField(row, ['status']),
      sortOrder: index,
    }));
  });

  return { prescriptions, warnings: [...new Set(warnings)] };
}

function parseColumnList(value: unknown, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return cleanString(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => allowedSet.has(item));
}

function parseSettingsTable(table: ObjectTable | null): ProfileSettings | undefined {
  if (!table) return undefined;
  const map = new Map<string, unknown>();
  for (const rawRow of table.rows) {
    const row = mapObjectByNormalizedHeaders(rawRow);
    const setting = normalizeHeader(pickField(row, ['setting']));
    if (!setting) continue;
    map.set(setting, pickField(row, ['value']));
  }

  const timestamp = nowIso();
  const colorTheme = cleanString(map.get('color theme'));
  const weightUnit = cleanString(map.get('weight unit'));

  return {
    id: 'profile',
    passphraseEnabled: false,
    colorTheme: THEME_NAMES.includes(colorTheme as ThemeName) ? colorTheme as ThemeName : undefined,
    weightUnit: WEIGHT_UNITS.includes(weightUnit as WeightUnit) ? weightUnit as WeightUnit : undefined,
    startWeight: parseNumber(map.get('start weight')),
    goalWeight: parseNumber(map.get('goal weight')),
    healthColOrder: parseColumnList(map.get('health column order'), HEALTH_COL_KEYS) as HealthColKey[],
    healthHiddenCols: parseColumnList(map.get('health hidden columns'), HEALTH_COL_KEYS) as HealthColKey[],
    dosageColOrder: parseColumnList(map.get('dosage column order'), DOSAGE_COL_KEYS) as DosageColKey[],
    dosageHiddenCols: parseColumnList(map.get('dosage hidden columns'), DOSAGE_COL_KEYS) as DosageColKey[],
    vialColOrder: parseColumnList(map.get('vial column order'), VIAL_COL_KEYS) as VialColKey[],
    vialHiddenCols: parseColumnList(map.get('vial hidden columns'), VIAL_COL_KEYS) as VialColKey[],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function parseGenericTables(tables: ObjectTable[]) {
  const data: ImportData = { entries: [], prescriptions: [] };
  const warnings: string[] = [];

  for (const table of tables) {
    const classification = classifyTable(table);
    if (classification === 'prescription') {
      const parsed = parsePrescriptionTable(table);
      data.prescriptions.push(...parsed.prescriptions);
      warnings.push(...parsed.warnings);
    } else if (classification === 'health') {
      const parsed = parseHealthLikeTable(table);
      data.entries.push(...parsed.data.entries);
      warnings.push(...parsed.warnings);
    }
  }

  return { data, warnings: [...new Set(warnings)] };
}

function parseEvolvTrackSpreadsheet(workbook: SpreadsheetWorkbook): ImportParseResult {
  const metadata = getSpreadsheetMetadata(workbook);
  const healthTable = tableFromSheet(workbookSheet(workbook, 'Health Log'));
  const injectionsTable = tableFromSheet(workbookSheet(workbook, 'Injections'));
  const medicationTable = tableFromSheet(workbookSheet(workbook, 'Medication'));
  const settingsTable = tableFromSheet(workbookSheet(workbook, 'Settings'));
  const warnings: string[] = [];
  const data: ImportData = { entries: [], prescriptions: [] };

  if (healthTable) {
    const parsed = parseHealthLikeTable(healthTable);
    data.entries = parsed.data.entries;
    warnings.push(...parsed.warnings);
  }

  // Fall back to a dedicated Injections sheet only when the Health Log carried
  // no doses (older exports kept doses separate).
  if (!data.entries.some((e) => e.amountMg != null) && injectionsTable) {
    const parsed = parseHealthLikeTable(injectionsTable);
    data.entries.push(...parsed.data.entries.filter((e) => e.amountMg != null));
    warnings.push(...parsed.warnings);
  }

  if (medicationTable) {
    const parsed = parsePrescriptionTable(medicationTable);
    data.prescriptions = parsed.prescriptions;
    warnings.push(...parsed.warnings);
  }

  data.profile = parseSettingsTable(settingsTable);

  if (metadata.spreadsheetFormatVersion && metadata.spreadsheetFormatVersion > SPREADSHEET_FORMAT_VERSION) {
    warnings.push(
      `This spreadsheet uses format version ${metadata.spreadsheetFormatVersion}; this app supports version ${SPREADSHEET_FORMAT_VERSION}. Import will continue with compatible sheets.`,
    );
  }

  return {
    source: 'EvolvTrack spreadsheet',
    sourceDetail: [
      metadata.appVersion ? `app ${metadata.appVersion}` : '',
      metadata.spreadsheetFormatVersion ? `spreadsheet v${metadata.spreadsheetFormatVersion}` : '',
    ].filter(Boolean).join(', ') || undefined,
    data,
    warnings: [...new Set(warnings)],
  };
}

function collectObjectTablesFromJson(value: unknown): ObjectTable[] {
  const tables: ObjectTable[] = [];
  const seen = new WeakSet<object>();

  function visit(current: unknown, path: string[]) {
    if (Array.isArray(current)) {
      if (current.every(isObject)) {
        const rows = current.map((item) => mapObjectByNormalizedHeaders(item));
        const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        if (headers.length) tables.push({ name: path.join('.') || 'JSON', headers, rows });
      }
      current.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }

    if (!isObject(current) || seen.has(current)) return;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      visit(child, [...path, key]);
    }
  }

  visit(value, []);
  return tables;
}

async function parseJsonFile(file: File): Promise<ImportParseResult> {
  const text = await file.text();
  const payload = JSON.parse(text) as unknown;
  const backup = parseBackupPayload(payload);

  if (backup) {
    const warnings = backup.formatVersion > BACKUP_FORMAT_VERSION
      ? [`This backup uses format version ${backup.formatVersion}; this app supports version ${BACKUP_FORMAT_VERSION}. Import will continue with compatible fields.`]
      : [];

    return {
      source: 'EvolvTrack backup',
      sourceDetail: `app ${backup.appVersion}, backup v${backup.formatVersion}`,
      data: {
        entries: backup.data.entries,
        prescriptions: backup.data.prescriptions,
        profile: backup.data.profile,
      },
      warnings,
    };
  }
  if (isEvolvTrackBackupEnvelope(payload)) throw new Error(NO_COMPATIBLE_IMPORT_DATA);

  const tables = collectObjectTablesFromJson(payload);
  const parsed = parseGenericTables(tables);
  return {
    source: 'External JSON',
    sourceDetail: detectExternalSource(file.name, tables, text.slice(0, 1500)),
    data: parsed.data,
    warnings: parsed.warnings,
  };
}

async function parseCsvFile(file: File): Promise<ImportParseResult> {
  const { parseCsv } = await import('hucre/csv');
  const rows = parseCsv(await file.text(), { typeInference: true, skipEmptyRows: true });
  const table = tableFromRows(file.name, rows);
  const tables = table ? [table] : [];
  const parsed = parseGenericTables(tables);

  return {
    source: 'External CSV',
    sourceDetail: detectExternalSource(file.name, tables),
    data: parsed.data,
    warnings: parsed.warnings,
  };
}

async function parseSpreadsheet(file: File): Promise<ImportParseResult> {
  const workbook = await readSpreadsheetFile(file);
  if (isEvolvTrackSpreadsheet(workbook)) return parseEvolvTrackSpreadsheet(workbook);

  const tables = workbook.sheets
    .map((sheet) => tableFromSheet(sheet))
    .filter((table): table is ObjectTable => Boolean(table));
  const parsed = parseGenericTables(tables);

  return {
    source: 'External spreadsheet',
    sourceDetail: detectExternalSource(file.name, tables),
    data: parsed.data,
    warnings: parsed.warnings,
  };
}

function hasImportData(data: ImportData) {
  return data.entries.length > 0 || data.prescriptions.length > 0 || Boolean(data.profile);
}

function canonicalizeImportData(data: ImportData): ImportData {
  const parsed = canonicalDomain.parseCollections(data);
  if (parsed.accepted) return parsed.value;
  throw new Error(NO_COMPATIBLE_IMPORT_DATA);
}

export async function parseTrackingFile(file: File): Promise<ImportParseResult> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  let result: ImportParseResult;

  if (extension === 'json') {
    result = await parseJsonFile(file);
  } else if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
    result = await parseCsvFile(file);
  } else if (extension === 'xlsx' || extension === 'ods') {
    result = await parseSpreadsheet(file);
  } else {
    throw new Error('Unsupported import file. Use an EvolvTrack backup, CSV, JSON, ODS, or XLSX file.');
  }

  result.data = canonicalizeImportData(result.data);

  if (!hasImportData(result.data)) {
    throw new Error(NO_COMPATIBLE_IMPORT_DATA);
  }

  return {
    ...result,
    warnings: mergeWarnings(result.warnings),
  };
}

/** Day + recorded weight identify a weight reading. Weight-less rows
 * (wellness/symptom-only) collapse by day alone so re-imports of them also
 * dedupe. Rounded to 0.1 lb so trivial float noise doesn't defeat the match. */
function entryDedupeKey(
  e: Pick<HealthEntry, 'date' | 'weightLbs' | 'amountMg' | 'medication'>,
): string {
  const lbs = e.weightLbs != null ? Math.round(e.weightLbs * 10) / 10 : 'none';
  const dose = e.amountMg != null ? e.amountMg.toFixed(3) : 'none';
  return `${e.date}#${lbs}#${dose}#${e.medication ?? ''}`;
}

export type DedupeResult = {
  data: ImportData;
  skipped: number;
};

/**
 * Drop imported rows that duplicate data already present (in the DB, or earlier
 * in the same import batch) so a merge import doesn't pile on copies.
 *
 *  - Weights: same day + same recorded weight ⇒ duplicate.
 *  - Injections: same day + same dose amount, where the medications match OR
 *    either side has no medication. The "no medication" case implements the
 *    rule "if the dose matches but the drug is blank, assume it's the same drug
 *    logged that day." Two *different* known drugs at the same dose on the same
 *    day are kept (legitimately distinct).
 *
 * Prescriptions are left untouched — they aren't day-scoped, and a backup
 * re-import overwrites them by id anyway.
 */
export function dedupeAgainstExisting(
  data: ImportData,
  existing: { entries: Pick<HealthEntry, 'date' | 'weightLbs' | 'amountMg' | 'medication'>[] },
): DedupeResult {
  const seen = new Set(existing.entries.map(entryDedupeKey));
  const entries: HealthEntry[] = [];
  let skipped = 0;
  for (const e of data.entries) {
    const key = entryDedupeKey(e);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    entries.push(e);
  }

  return { data: { ...data, entries }, skipped };
}

async function applyParsedImport(parsed: ImportParseResult, mode: ImportMode): Promise<void> {
  // Merge mode: drop rows that duplicate data already on this device (or earlier
  // in the same file) so re-importing doesn't create copies. Replace mode wipes
  // first, so there's nothing to dedupe against.
  if (mode === 'merge') {
    const existingEntries = await db.entries.toArray();
    const deduped = dedupeAgainstExisting(parsed.data, { entries: existingEntries });
    parsed.data.entries = deduped.data.entries;
    const skipped = deduped.skipped;
    if (skipped > 0) {
      parsed.warnings = [
        ...parsed.warnings,
        `Skipped ${skipped} duplicate row${skipped === 1 ? '' : 's'} already present for those days.`,
      ];
    }
  }

  const replaceProfile = parsed.source === 'EvolvTrack backup' || parsed.source === 'EvolvTrack spreadsheet' || Boolean(parsed.data.profile);

  // Collect every symptom referenced by the imported rows up-front. Folded
  // into the profile write below so the import produces exactly one profile
  // outbox entry (not one for `parsed.data.profile` and a second for the
  // newly-registered symptoms).
  const importedSymptoms = new Set<string>();
  for (const e of parsed.data.entries) {
    for (const s of e.symptoms ?? []) importedSymptoms.add(s);
  }

  let mergedProfile: ProfileSettings | undefined;
  const tables = [db.entries, db.prescriptions, db.profile, db.outbox];
  await db.transaction('rw', tables, async () => {
    let deletedIds: { entries: string[]; prescriptions: string[] } | undefined;
    if (mode === 'replace') {
      // Capture pre-clear primary keys so the outbox can publish delete
      // tombstones for them. Without this, replace-mode imports drop local
      // rows but leave the cloud copies in place, and the next pull
      // resurrects them.
      const [entryIds, prescriptionIds] = await Promise.all([
        db.entries.toCollection().primaryKeys(),
        db.prescriptions.toCollection().primaryKeys(),
      ]);
      deletedIds = {
        entries: entryIds as string[],
        prescriptions: prescriptionIds as string[],
      };
      await Promise.all([
        db.entries.clear(),
        db.prescriptions.clear(),
        replaceProfile ? db.profile.clear() : Promise.resolve(),
      ]);
    }

    await Promise.all([
      parsed.data.entries.length ? db.entries.bulkPut(parsed.data.entries) : Promise.resolve(),
      parsed.data.prescriptions.length ? db.prescriptions.bulkPut(parsed.data.prescriptions) : Promise.resolve(),
    ]);

    // Bulk imports normally bypass the per-row mutate helpers that enqueue
    // outbox entries. Re-attach the sync trail here; the profile (including
    // any imported `profile` block and any newly-registered symptoms) is
    // written and enqueued in one atomic step by `enqueueImportedRows`.
    mergedProfile = await enqueueImportedRows(parsed.data, { deletedIds, importedSymptoms });
  });

  // The store's liveQuery will eventually pick this up, but hydrate
  // synchronously so callers awaiting the import see the dropdown updated
  // by the time control returns.
  if (mergedProfile) hydrateSymptomStoresFromProfile(mergedProfile);

  // Notify the in-memory health cache about the bulk write so it doesn't go stale.
  if (mode === 'replace') emitHealthChange({ action: 'reset' });
  for (const e of parsed.data.entries) emitHealthChange({ action: 'add', entity: e });

  const earliest = parsed.data.entries
    .filter((e) => e.weightLbs != null)
    .reduce<typeof parsed.data.entries[number] | null>((acc, e) => {
      if (!acc) return e;
      if (e.date < acc.date) return e;
      if (e.date === acc.date && e.createdAt < acc.createdAt) return e;
      return acc;
    }, null);
  if (earliest?.weightLbs != null) void setStartWeightIfUnset(earliest.weightLbs);
}

export async function importTrackingFile(file: File, mode: ImportMode): Promise<ImportApplyResult> {
  const parsed = await parseTrackingFile(file);
  await applyParsedImport(parsed, mode);
  return {
    ...parsed,
    mode,
  };
}

export function importResultSummary(result: Pick<ImportApplyResult, 'source' | 'sourceDetail' | 'data' | 'mode'>) {
  const detail = result.sourceDetail ? ` from ${result.sourceDetail}` : '';
  const action = result.mode === 'replace' ? 'Replaced data with' : 'Imported';
  const weighIns = result.data.entries.filter((e) => e.weightLbs != null).length;
  const doses = result.data.entries.filter((e) => e.amountMg != null).length;
  const counts = [
    `${weighIns} weight entr${weighIns === 1 ? 'y' : 'ies'}`,
    `${doses} injection${doses === 1 ? '' : 's'}`,
    `${result.data.prescriptions.length} medication row${result.data.prescriptions.length === 1 ? '' : 's'}`,
  ];
  if (result.data.profile) counts.push('settings');
  return `${action} ${counts.join(', ')} from ${result.source}${detail}.`;
}

export function emptyImportData(): ImportData {
  return {
    entries: [...EMPTY_IMPORT_DATA.entries],
    prescriptions: [...EMPTY_IMPORT_DATA.prescriptions],
  };
}

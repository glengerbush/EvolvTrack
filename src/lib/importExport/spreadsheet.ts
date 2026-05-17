import { getAllInjections, getAllPrescriptions, getAllWeights, getProfile } from '$lib/domain/repo';
import type { InjectionEntry, IsoDate, Prescription, ProfileSettings, WeightEntry } from '$lib/domain/types';
import { APP_VERSION } from '$lib/version';
import { DB_SCHEMA_VERSION } from '$lib/db/schema';
import { dateStamp, downloadBytes } from '$lib/importExport/download';
import {
  cleanString,
  round,
  weightFromStoredLbs,
} from '$lib/importExport/shared';
import {
  DRUG_PK,
  calculateSystemMgByDrug,
  type DrugPK,
} from '$lib/utils/pharmacokinetics';

export type SpreadsheetCellValue = string | number | boolean | Date | null;

type Color = { rgb?: string };
type FontStyle = {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: Color;
};
type FillStyle = {
  type: 'pattern';
  pattern: 'solid';
  fgColor?: Color;
};
type BorderSide = {
  style: 'thin';
  color?: Color;
};
type CellStyle = {
  font?: FontStyle;
  fill?: FillStyle;
  border?: {
    top?: BorderSide;
    right?: BorderSide;
    bottom?: BorderSide;
    left?: BorderSide;
  };
  alignment?: {
    horizontal?: 'left' | 'center' | 'right';
    vertical?: 'top' | 'center' | 'bottom';
    wrapText?: boolean;
  };
  numFmt?: string;
};
type ColumnDef = {
  width?: number;
  hidden?: boolean;
  style?: CellStyle;
  numFmt?: string;
};
type CellOverride = {
  style?: CellStyle;
  formula?: string;
  formulaResult?: SpreadsheetCellValue;
  value?: SpreadsheetCellValue;
};
type MergeRange = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};
type WriteSheet = {
  name: string;
  columns?: ColumnDef[];
  rows?: SpreadsheetCellValue[][];
  cells?: Map<string, CellOverride>;
  merges?: MergeRange[];
  autoFilter?: { range: string };
  freezePane?: { rows?: number; columns?: number };
  view?: { showGridLines?: boolean; tabColor?: Color };
  hidden?: boolean;
  rowDefs?: Map<number, { height?: number }>;
};
type WriteOptions = {
  sheets: WriteSheet[];
  properties?: {
    title?: string;
    subject?: string;
    creator?: string;
    description?: string;
    created?: Date;
    modified?: Date;
  };
  defaultFont?: FontStyle;
  activeSheet?: number;
};

export type SpreadsheetSheet = {
  name: string;
  rows: SpreadsheetCellValue[][];
};

export type SpreadsheetWorkbook = {
  sheets: SpreadsheetSheet[];
};

export type SpreadsheetMetadata = {
  app?: string;
  kind?: string;
  spreadsheetFormatVersion?: number;
  appVersion?: string;
  dbSchemaVersion?: number;
  exportedAt?: string;
};

const EXPORT_MARKER = 'EvolvTrack spreadsheet';
export const SPREADSHEET_APP_ID = 'EvolvTrack';
export const SPREADSHEET_KIND = 'spreadsheet';
export const SPREADSHEET_FORMAT_VERSION = 1;
const METADATA_SHEET_NAME = '_EvolvTrack_Metadata';
const HEADER_BG = '1F7A3A';
const HEADER_TEXT = 'FFFFFF';
const SURFACE_GREEN = 'D8E2CB';
const BORDER = '7388A6';
const TEXT = '111111';
const MUTED = '5F635D';
const ORANGE = 'C5682F';
const HEALTH_TRACKER_MIN_ROWS = 500;
const HEALTH_TRACKER_EXTRA_ROWS = 365;
const MEDICATION_TRACKER_MIN_ROWS = 80;
const MEDICATION_TRACKER_EXTRA_ROWS = 20;

const baseFont = { name: 'Arial', size: 11, color: { rgb: TEXT } };
const titleStyle: CellStyle = {
  font: { ...baseFont, bold: true, size: 18, color: { rgb: HEADER_TEXT } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { rgb: HEADER_BG } },
  alignment: { vertical: 'center' },
};
const sectionStyle: CellStyle = {
  font: { ...baseFont, bold: true, color: { rgb: HEADER_TEXT } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { rgb: HEADER_BG } },
  border: { bottom: { style: 'thin', color: { rgb: BORDER } } },
  alignment: { vertical: 'center', wrapText: true },
};
const labelStyle: CellStyle = {
  font: { ...baseFont, bold: true, color: { rgb: MUTED } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { rgb: SURFACE_GREEN } },
};
const noteStyle: CellStyle = {
  font: { ...baseFont, color: { rgb: MUTED } },
  alignment: { wrapText: true, vertical: 'top' },
};
const numberStyle: CellStyle = {
  font: baseFont,
  alignment: { horizontal: 'right' },
};
const dateStyle: CellStyle = {
  font: baseFont,
  numFmt: 'yyyy-mm-dd',
};
const calculatedStyle: CellStyle = {
  font: baseFont,
  fill: { type: 'pattern', pattern: 'solid', fgColor: { rgb: 'EEF1EA' } },
};
const calculatedNumberStyle: CellStyle = {
  ...calculatedStyle,
  alignment: { horizontal: 'right' },
  numFmt: '0.00',
};
const currencyStyle: CellStyle = {
  ...numberStyle,
  numFmt: '$#,##0.00',
};
const warningStyle: CellStyle = {
  font: { ...baseFont, color: { rgb: ORANGE } },
};

type SheetInput = {
  name: string;
  rows: SpreadsheetCellValue[][];
  columns: ColumnDef[];
  headerRow?: number;
  hidden?: boolean;
  merges?: WriteSheet['merges'];
};

type ExportData = {
  weights: WeightEntry[];
  injections: InjectionEntry[];
  prescriptions: Prescription[];
  profile?: ProfileSettings;
};

function colName(index: number): string {
  let name = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - remainder - 1) / 26);
  }
  return name;
}

function tableRange(rowCount: number, colCount: number) {
  return `A1:${colName(colCount - 1)}${Math.max(rowCount, 1)}`;
}

function cellKey(row: number, col: number) {
  return `${row},${col}`;
}

function mergeCellOverride(cells: Map<string, CellOverride>, row: number, col: number, override: CellOverride) {
  const key = cellKey(row, col);
  const existing = cells.get(key) ?? {};
  cells.set(key, {
    ...existing,
    ...override,
    style: override.style ?? existing.style,
  });
}

function styleRow(cells: Map<string, CellOverride>, row: number, colCount: number, style: CellStyle) {
  for (let col = 0; col < colCount; col += 1) {
    mergeCellOverride(cells, row, col, { style });
  }
}

function dateCell(dateKey: string | undefined): Date | '' {
  if (!dateKey) return '';
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Date(year, month - 1, day);
}

function formulaCell(
  cells: Map<string, CellOverride> | undefined,
  row: number,
  col: number,
  formula: string,
  formulaResult: SpreadsheetCellValue,
  style?: CellStyle,
) {
  if (!cells) return;
  mergeCellOverride(cells, row, col, { formula, formulaResult, style });
}

function odsFormula(formula: string) {
  let converted = '';
  let inString = false;

  for (let index = 0; index < formula.length; index += 1) {
    const char = formula[index];
    if (char === '"') {
      converted += char;
      if (inString && formula[index + 1] === '"') {
        converted += formula[index + 1];
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    converted += char === ',' && !inString ? ';' : char;
  }

  return converted;
}

function odsWorkbookOptions(workbook: WriteOptions): WriteOptions {
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => {
      if (!sheet.cells) return sheet;
      const cells = new Map<string, CellOverride>();
      for (const [key, override] of sheet.cells) {
        cells.set(key, override.formula ? { ...override, formula: odsFormula(override.formula) } : override);
      }
      return { ...sheet, cells };
    }),
  };
}

function trackerRowCount(existingRows: number, minRows: number, extraRows: number) {
  return Math.max(existingRows + extraRows, minRows);
}

function spreadsheetMetadataRows(exportedAt: string): SpreadsheetCellValue[][] {
  return [
    ['Key', 'Value'],
    ['app', SPREADSHEET_APP_ID],
    ['kind', SPREADSHEET_KIND],
    ['spreadsheetFormatVersion', SPREADSHEET_FORMAT_VERSION],
    ['appVersion', APP_VERSION],
    ['dbSchemaVersion', DB_SCHEMA_VERSION],
    ['exportedAt', exportedAt],
  ];
}

function buildMetadataSheet(exportedAt: string): WriteSheet {
  return buildSheet({
    name: METADATA_SHEET_NAME,
    rows: spreadsheetMetadataRows(exportedAt),
    columns: [
      { width: 28 },
      { width: 34 },
    ],
    hidden: true,
  });
}

function buildSheet(input: SheetInput): WriteSheet {
  const cells = new Map<string, CellOverride>();
  const rowDefs = new Map<number, { height: number }>();
  const headerRow = input.headerRow ?? 0;

  if (input.rows[0]) {
    styleRow(cells, headerRow, input.rows[headerRow]?.length ?? input.columns.length, sectionStyle);
    rowDefs.set(headerRow, { height: 24 });
  }

  if (input.name === 'Summary') {
    styleRow(cells, 0, Math.max(input.rows[0]?.length ?? 1, 4), titleStyle);
    for (let row = 2; row < input.rows.length; row += 1) {
      if (input.rows[row]?.[0]) cells.set(cellKey(row, 0), { style: labelStyle });
      if (input.rows[row]?.[1]) cells.set(cellKey(row, 1), { style: noteStyle });
    }
  }

  return {
    name: input.name,
    rows: input.rows,
    columns: input.columns,
    cells,
    rowDefs,
    merges: input.merges,
    freezePane: input.name === 'Summary' ? undefined : { rows: 1 },
    autoFilter: input.name === 'Summary' ? undefined : { range: tableRange(input.rows.length, input.columns.length) },
    view: { showGridLines: false, tabColor: { rgb: HEADER_BG } },
    hidden: input.hidden,
  };
}

function dateLabel(dateKey: string) {
  const parsed = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { weekday: 'long' });
}

function formatList(items: string[] | undefined) {
  return (items ?? []).join(', ');
}

function medicationPk(medication: string | undefined): DrugPK | null {
  if (!medication || !(medication in DRUG_PK)) return null;
  return DRUG_PK[medication as keyof typeof DRUG_PK];
}

function pkFormula(cellRef: string, field: keyof Pick<DrugPK, 'bioavailability' | 'ka' | 'ke'>) {
  const aliases = [
    ['Semaglutide', DRUG_PK['Semaglutide (Ozempic / Wegovy)'][field]],
    ['Tirzepatide', DRUG_PK['Tirzepatide (Mounjaro / Zepbound)'][field]],
    ['Dulaglutide', DRUG_PK['Dulaglutide (Trulicity)'][field]],
    ['Liraglutide', DRUG_PK['Liraglutide (Victoza / Saxenda)'][field]],
    ['Retatrutide', DRUG_PK.Retatrutide[field]],
  ] as const;

  const nested = aliases
    .slice()
    .reverse()
    .reduce(
      (fallback, [name, value]) => `IF(ISNUMBER(SEARCH("${name}",${cellRef})),${value},${fallback})`,
      '""',
    );

  return `IF(${cellRef}="","",${nested})`;
}

function systemFormula(rowNumber: number, lastRowNumber: number) {
  const range = (column: string) => `$${column}$2:$${column}$${lastRowNumber}`;
  const elapsedHours = `(${rowNumber === 2 ? 'A2' : `A${rowNumber}`}-${range('A')})*24`;
  return [
    `IF(A${rowNumber}="","",`,
    'ROUND(',
    'SUMPRODUCT(IFERROR(',
    `(${range('A')}<>"")*(${range('A')}<=A${rowNumber})*(${range('H')}>0)*`,
    `(${range('M')}*${range('H')}*${range('N')}/(${range('N')}-${range('O')}))*`,
    `(EXP(-${range('O')}*${elapsedHours})-EXP(-${range('N')}*${elapsedHours}))`,
    ',0)),',
    '2))',
  ].join('');
}

function normalizeInjectionSnapshot(injections: InjectionEntry[]) {
  let lastKnownMedication = '';
  return [...injections]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .filter((injection) => Number.isFinite(injection.amountMg) && injection.amountMg > 0)
    .map((injection) => {
      const medication = injection.medication || lastKnownMedication;
      if (injection.medication) lastKnownMedication = injection.medication;
      return { date: injection.date, amountMg: injection.amountMg, medication };
    })
    .filter((injection) => injection.medication);
}

function systemLabel(injections: InjectionEntry[], date: IsoDate) {
  const amounts = calculateSystemMgByDrug(normalizeInjectionSnapshot(injections), date);
  return round(amounts.reduce((total, amount) => total + amount.amountMg, 0), 2);
}

function buildSummarySheet(data: ExportData, exportedAt: string): WriteSheet {
  const unit = data.profile?.weightUnit ?? 'lbs';
  const currentWeight = [...data.weights]
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .find((weight) => weight.weightLbs != null)?.weightLbs;
  const activeMedication = data.prescriptions.find((prescription) => prescription.status === 'active')?.type ?? '';

  return buildSheet({
    name: 'Summary',
    rows: [
      ['EvolvTrack Export'],
      [],
      ['Format', EXPORT_MARKER],
      ['Spreadsheet format version', SPREADSHEET_FORMAT_VERSION],
      ['App version', APP_VERSION],
      ['Database schema version', DB_SCHEMA_VERSION],
      ['Exported at', exportedAt],
      ['Weight unit', unit],
      ['Weights', data.weights.length],
      ['Injections', data.injections.length],
      ['Medication rows', data.prescriptions.length],
      [],
      ['Current weight', weightFromStoredLbs(currentWeight, unit)],
      ['Start weight', weightFromStoredLbs(data.profile?.startWeight, unit)],
      ['Goal weight', weightFromStoredLbs(data.profile?.goalWeight, unit)],
      ['Active medication', activeMedication],
    ],
    columns: [
      { width: 22 },
      { width: 42 },
      { width: 18 },
      { width: 18 },
    ],
    headerRow: 0,
    merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 3 }],
  });
}

function groupByDate<T extends { date: IsoDate; createdAt: string; id: string }>(items: T[]) {
  const grouped = new Map<IsoDate, T[]>();
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    grouped.set(item.date, [...(grouped.get(item.date) ?? []), item]);
  }
  return grouped;
}

function buildHealthSheet(data: ExportData): WriteSheet {
  const unit = data.profile?.weightUnit ?? 'lbs';
  const weightsByDate = groupByDate(data.weights);
  const injectionsByDate = groupByDate(data.injections);
  const dates = [...new Set([...weightsByDate.keys(), ...injectionsByDate.keys()])].sort();
  const rows: SpreadsheetCellValue[][] = [[
    'Date',
    'Day',
    `Weight (${unit})`,
    `Loss (${unit})`,
    'Wellness',
    'Symptoms',
    'Medication',
    'Dose (mg)',
    'Status',
    'Shot Location',
    'mg in system',
    'Notes',
    'Bioavailability',
    'Absorption rate',
    'Elimination rate',
    'Weight ID',
    'Injection ID',
  ]];
  let previousWeight: number | null = null;

  for (const date of dates) {
    const dateWeights = weightsByDate.get(date) ?? [];
    const dateInjections = injectionsByDate.get(date) ?? [];
    const rowCount = Math.max(dateWeights.length, dateInjections.length, 1);
    for (let index = 0; index < rowCount; index += 1) {
      const weight = dateWeights[index];
      const injection = dateInjections[index];
      const displayWeight = weightFromStoredLbs(weight?.weightLbs, unit);
      const loss = typeof displayWeight === 'number' && previousWeight != null
        ? round(previousWeight - displayWeight, 1)
        : '';
      if (typeof displayWeight === 'number') previousWeight = displayWeight;

      rows.push([
        dateCell(date),
        dateLabel(date),
        displayWeight,
        loss,
        weight?.wellness ?? '',
        formatList(weight?.symptoms ?? injection?.symptoms),
        injection?.medication ?? '',
        injection?.amountMg ?? '',
        injection?.planned ? 'Planned' : injection ? 'Confirmed' : '',
        injection?.site ?? '',
        systemLabel(data.injections, date),
        weight?.notes ?? injection?.notes ?? '',
        medicationPk(injection?.medication)?.bioavailability ?? '',
        medicationPk(injection?.medication)?.ka ?? '',
        medicationPk(injection?.medication)?.ke ?? '',
        weight?.id ?? '',
        injection?.id ?? '',
      ]);
    }
  }

  const existingDataRows = rows.length - 1;
  const dataRowCount = trackerRowCount(existingDataRows, HEALTH_TRACKER_MIN_ROWS, HEALTH_TRACKER_EXTRA_ROWS);
  while (rows.length <= dataRowCount) {
    rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  }

  const sheet = buildSheet({
    name: 'Health Log',
    rows,
    columns: [
      { width: 13, style: dateStyle },
      { width: 12, style: calculatedStyle },
      { width: 13, style: numberStyle },
      { width: 12, style: calculatedNumberStyle },
      { width: 10, style: numberStyle },
      { width: 28 },
      { width: 34 },
      { width: 11, style: numberStyle },
      { width: 11, style: calculatedStyle },
      { width: 18 },
      { width: 14, style: calculatedNumberStyle },
      { width: 34, style: noteStyle },
      { width: 0, hidden: true },
      { width: 0, hidden: true },
      { width: 0, hidden: true },
      { width: 0, hidden: true },
      { width: 0, hidden: true },
    ],
  });
  const lastRowNumber = dataRowCount + 1;
  for (let row = 1; row <= dataRowCount; row += 1) {
    const rowNumber = row + 1;
    const doseValue = typeof rows[row]?.[7] === 'number' ? rows[row][7] as number : undefined;
    const medication = typeof rows[row]?.[6] === 'string' ? rows[row][6] as string : '';
    const pk = medicationPk(medication);

    formulaCell(
      sheet.cells,
      row,
      1,
      `IF(A${rowNumber}="","",TEXT(A${rowNumber},"dddd"))`,
      rows[row]?.[1] ?? '',
      calculatedStyle,
    );

    formulaCell(
      sheet.cells,
      row,
      3,
      rowNumber === 2
        ? '""'
        : `IF(C${rowNumber}="","",IFERROR(LOOKUP(2,1/($C$2:C${rowNumber - 1}<>""),$C$2:C${rowNumber - 1})-C${rowNumber},""))`,
      rows[row]?.[3] ?? '',
      calculatedNumberStyle,
    );

    formulaCell(
      sheet.cells,
      row,
      8,
      `IF(H${rowNumber}="","",IF(A${rowNumber}>TODAY(),"Planned","Confirmed"))`,
      rows[row]?.[8] ?? '',
      rows[row]?.[8] === 'Planned' ? warningStyle : calculatedStyle,
    );

    formulaCell(
      sheet.cells,
      row,
      10,
      systemFormula(rowNumber, lastRowNumber),
      rows[row]?.[10] ?? '',
      calculatedNumberStyle,
    );

    formulaCell(
      sheet.cells,
      row,
      12,
      pkFormula(`G${rowNumber}`, 'bioavailability'),
      doseValue != null ? pk?.bioavailability ?? '' : '',
    );
    formulaCell(
      sheet.cells,
      row,
      13,
      pkFormula(`G${rowNumber}`, 'ka'),
      doseValue != null ? pk?.ka ?? '' : '',
    );
    formulaCell(
      sheet.cells,
      row,
      14,
      pkFormula(`G${rowNumber}`, 'ke'),
      doseValue != null ? pk?.ke ?? '' : '',
    );
  }
  return sheet;
}

function buildInjectionSheet(data: ExportData): WriteSheet {
  const rows: SpreadsheetCellValue[][] = [[
    'Date',
    'Medication',
    'Dose (mg)',
    'Status',
    'Confirmed At',
    'Shot Location',
    'Symptoms',
    'Notes',
    'Injection ID',
  ]];

  for (const injection of [...data.injections].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))) {
    rows.push([
      dateCell(injection.date),
      injection.medication,
      injection.amountMg,
      injection.planned ? 'Planned' : 'Confirmed',
      injection.confirmedAt ?? '',
      injection.site,
      formatList(injection.symptoms),
      injection.notes ?? '',
      injection.id,
    ]);
  }

  return buildSheet({
    name: 'Injections',
    rows,
    columns: [
      { width: 13, style: dateStyle },
      { width: 34 },
      { width: 11, style: numberStyle },
      { width: 11 },
      { width: 24 },
      { width: 18 },
      { width: 28 },
      { width: 36, style: noteStyle },
      { width: 0, hidden: true },
    ],
  });
}

function buildMedicationSheet(data: ExportData): WriteSheet {
  const rows: SpreadsheetCellValue[][] = [[
    'Type',
    'Concentration (mg/mL)',
    'Additive',
    'ml in Vial',
    'Prescribed Dosage (mg)',
    'Doses Left',
    'Compound Date',
    'BUD',
    'Pharmacy',
    'Lot Number',
    'Cost',
    '$/mg',
    'Status',
    'Prescription ID',
  ]];

  for (const prescription of data.prescriptions) {
    const totalMg = (prescription.concentrationMgMl ?? 0) * (prescription.vialMl ?? 0);
    rows.push([
      prescription.type ?? '',
      prescription.concentrationMgMl ?? '',
      prescription.additive ?? '',
      prescription.vialMl ?? '',
      prescription.prescribedDoseMg ?? '',
      prescription.dosesLeft ?? '',
      dateCell(prescription.compoundDate),
      dateCell(prescription.bud),
      prescription.pharmacy ?? '',
      prescription.lotNumber ?? '',
      prescription.costUsd ?? '',
      totalMg > 0 && prescription.costUsd != null ? round(prescription.costUsd / totalMg, 2) : '',
      prescription.status ?? '',
      prescription.id,
    ]);
  }

  const existingDataRows = rows.length - 1;
  const dataRowCount = trackerRowCount(existingDataRows, MEDICATION_TRACKER_MIN_ROWS, MEDICATION_TRACKER_EXTRA_ROWS);
  while (rows.length <= dataRowCount) {
    rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  }

  const sheet = buildSheet({
    name: 'Medication',
    rows,
    columns: [
      { width: 34 },
      { width: 20, style: numberStyle },
      { width: 16 },
      { width: 11, style: numberStyle },
      { width: 22, style: numberStyle },
      { width: 12, style: numberStyle },
      { width: 15, style: dateStyle },
      { width: 15, style: dateStyle },
      { width: 20 },
      { width: 16 },
      { width: 12, style: currencyStyle },
      { width: 12, style: { ...currencyStyle, ...calculatedStyle } },
      { width: 11 },
      { width: 0, hidden: true },
    ],
  });
  for (let row = 1; row <= dataRowCount; row += 1) {
    const rowNumber = row + 1;
    formulaCell(
      sheet.cells,
      row,
      11,
      `IF(COUNTA(B${rowNumber},D${rowNumber},K${rowNumber})=0,"",IFERROR(K${rowNumber}/(B${rowNumber}*D${rowNumber}),""))`,
      rows[row]?.[11] ?? '',
      currencyStyle,
    );
  }
  return sheet;
}

function serializeSetting(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  return cleanString(value);
}

function buildSettingsSheet(data: ExportData): WriteSheet {
  const profile = data.profile;
  const rows: SpreadsheetCellValue[][] = [[
    'Setting',
    'Value',
  ]];
  if (profile) {
    rows.push(
      ['Color theme', serializeSetting(profile.colorTheme)],
      ['Weight unit', serializeSetting(profile.weightUnit)],
      ['Start weight', profile.startWeight ?? ''],
      ['Goal weight', profile.goalWeight ?? ''],
      ['Health column order', serializeSetting(profile.healthColOrder)],
      ['Health hidden columns', serializeSetting(profile.healthHiddenCols)],
      ['Dosage column order', serializeSetting(profile.dosageColOrder)],
      ['Dosage hidden columns', serializeSetting(profile.dosageHiddenCols)],
      ['Vial column order', serializeSetting(profile.vialColOrder)],
      ['Vial hidden columns', serializeSetting(profile.vialHiddenCols)],
    );
  }

  return buildSheet({
    name: 'Settings',
    rows,
    columns: [
      { width: 26 },
      { width: 58, style: noteStyle },
    ],
  });
}

async function collectExportData(): Promise<ExportData> {
  const [weights, injections, prescriptions, profile] = await Promise.all([
    getAllWeights(),
    getAllInjections(),
    getAllPrescriptions(),
    getProfile(),
  ]);
  return { weights, injections, prescriptions, profile };
}

function buildWorkbookOptions(data: ExportData): WriteOptions {
  const exportedAt = new Date().toISOString();

  return {
    sheets: [
      buildSummarySheet(data, exportedAt),
      buildHealthSheet(data),
      buildInjectionSheet(data),
      buildMedicationSheet(data),
      buildSettingsSheet(data),
      buildMetadataSheet(exportedAt),
    ],
    properties: {
      title: 'EvolvTrack Export',
      subject: EXPORT_MARKER,
      creator: 'EvolvTrack',
      description: 'Human-readable EvolvTrack health, injection, medication, and settings export.',
      created: new Date(),
      modified: new Date(),
    },
    defaultFont: baseFont,
    activeSheet: 0,
  };
}

export async function downloadOdsSpreadsheet() {
  const data = await collectExportData();
  const workbook = buildWorkbookOptions(data);
  const bytes = await (await import('hucre/ods')).writeOds(odsWorkbookOptions(workbook));
  downloadBytes(bytes, `evolvtrack-export-${dateStamp()}.ods`, 'application/vnd.oasis.opendocument.spreadsheet');
}

export async function readSpreadsheetFile(file: File): Promise<SpreadsheetWorkbook> {
  const bytes = await file.arrayBuffer();
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'ods') {
    return (await import('hucre/ods')).readOds(bytes);
  }
  return (await import('hucre/xlsx')).readXlsx(bytes);
}

function metadataNumber(value: SpreadsheetCellValue | undefined): number | undefined {
  const parsed = Number(cleanString(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function metadataRecordFromSheet(sheet: SpreadsheetSheet | undefined): Record<string, SpreadsheetCellValue> {
  const record: Record<string, SpreadsheetCellValue> = {};
  for (const row of sheet?.rows.slice(1) ?? []) {
    const key = cleanString(row[0]);
    if (!key) continue;
    record[key] = row[1];
  }
  return record;
}

export function getSpreadsheetMetadata(workbook: SpreadsheetWorkbook): SpreadsheetMetadata {
  const metadata = metadataRecordFromSheet(workbookSheet(workbook, METADATA_SHEET_NAME));
  const summary = workbookSheet(workbook, 'Summary');

  if (!Object.keys(metadata).length && summary) {
    Object.assign(metadata, metadataRecordFromSheet({ name: 'Summary', rows: summary.rows.slice(2, 8) }));
  }

  return {
    app: cleanString(metadata.app) || undefined,
    kind: cleanString(metadata.kind) || undefined,
    spreadsheetFormatVersion: metadataNumber(metadata.spreadsheetFormatVersion),
    appVersion: cleanString(metadata.appVersion) || cleanString(metadata['App version']) || undefined,
    dbSchemaVersion: metadataNumber(metadata.dbSchemaVersion),
    exportedAt: cleanString(metadata.exportedAt) || undefined,
  };
}

export function isEvolvTrackSpreadsheet(workbook: SpreadsheetWorkbook): boolean {
  const metadata = getSpreadsheetMetadata(workbook);
  if (metadata.app === SPREADSHEET_APP_ID && metadata.kind === SPREADSHEET_KIND) return true;

  const summary = workbook.sheets.find((sheet) => sheet.name === 'Summary');
  return Boolean(summary?.rows.some((row) => row.some((cell) => cleanString(cell) === EXPORT_MARKER)));
}

export function workbookSheet(workbook: SpreadsheetWorkbook, name: string) {
  return workbook.sheets.find((sheet) => sheet.name.toLowerCase() === name.toLowerCase());
}

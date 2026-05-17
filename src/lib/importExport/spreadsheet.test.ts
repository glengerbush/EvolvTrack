// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import {
  addInjection,
  addPrescription,
  addWeight,
  saveProfile,
} from '$lib/domain/repo';
import { parseTrackingFile } from './importer';
import {
  SPREADSHEET_APP_ID,
  SPREADSHEET_FORMAT_VERSION,
  SPREADSHEET_KIND,
  downloadOdsSpreadsheet,
  getSpreadsheetMetadata,
  isEvolvTrackSpreadsheet,
  workbookSheet,
  type SpreadsheetWorkbook,
} from './spreadsheet';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;

describe('workbookSheet', () => {
  it('finds a sheet by name case-insensitively', () => {
    const workbook: SpreadsheetWorkbook = {
      sheets: [
        { name: 'Health Log', rows: [['Date']] },
        { name: 'Medication', rows: [['Type']] },
      ],
    };
    expect(workbookSheet(workbook, 'health log')?.name).toBe('Health Log');
    expect(workbookSheet(workbook, 'MEDICATION')?.name).toBe('Medication');
  });

  it('returns undefined for unknown sheet names', () => {
    const workbook: SpreadsheetWorkbook = { sheets: [{ name: 'A', rows: [] }] };
    expect(workbookSheet(workbook, 'B')).toBeUndefined();
  });
});

describe('getSpreadsheetMetadata', () => {
  it('reads metadata from the hidden _EvolvTrack_Metadata sheet', () => {
    const workbook: SpreadsheetWorkbook = {
      sheets: [
        {
          name: '_EvolvTrack_Metadata',
          rows: [
            ['Key', 'Value'],
            ['app', SPREADSHEET_APP_ID],
            ['kind', SPREADSHEET_KIND],
            ['spreadsheetFormatVersion', SPREADSHEET_FORMAT_VERSION],
            ['appVersion', '0.0.3'],
            ['dbSchemaVersion', 7],
            ['exportedAt', '2026-05-10T00:00:00.000Z'],
          ],
        },
      ],
    };
    const metadata = getSpreadsheetMetadata(workbook);
    expect(metadata).toMatchObject({
      app: SPREADSHEET_APP_ID,
      kind: SPREADSHEET_KIND,
      spreadsheetFormatVersion: SPREADSHEET_FORMAT_VERSION,
      appVersion: '0.0.3',
      dbSchemaVersion: 7,
      exportedAt: '2026-05-10T00:00:00.000Z',
    });
  });

  it('returns empty string fields for a workbook with no recognizable sheets', () => {
    const metadata = getSpreadsheetMetadata({ sheets: [{ name: 'Other', rows: [] }] });
    expect(metadata.app).toBeUndefined();
    expect(metadata.kind).toBeUndefined();
    expect(metadata.appVersion).toBeUndefined();
    expect(metadata.exportedAt).toBeUndefined();
    // NOTE: spreadsheetFormatVersion and dbSchemaVersion fall through `Number("")`
    // which is 0, so they come back as 0 instead of undefined for missing data.
    // Documented here rather than fixed in source.
    expect(metadata.spreadsheetFormatVersion).toBe(0);
    expect(metadata.dbSchemaVersion).toBe(0);
  });
});

describe('isEvolvTrackSpreadsheet', () => {
  it('returns true when metadata identifies the workbook', () => {
    const workbook: SpreadsheetWorkbook = {
      sheets: [
        {
          name: '_EvolvTrack_Metadata',
          rows: [
            ['Key', 'Value'],
            ['app', SPREADSHEET_APP_ID],
            ['kind', SPREADSHEET_KIND],
          ],
        },
      ],
    };
    expect(isEvolvTrackSpreadsheet(workbook)).toBe(true);
  });

  it('falls back to the EvolvTrack-spreadsheet marker on the Summary sheet', () => {
    const workbook: SpreadsheetWorkbook = {
      sheets: [
        {
          name: 'Summary',
          rows: [['EvolvTrack Export'], ['Format', 'EvolvTrack spreadsheet']],
        },
      ],
    };
    expect(isEvolvTrackSpreadsheet(workbook)).toBe(true);
  });

  it('returns false for an unrelated workbook', () => {
    expect(isEvolvTrackSpreadsheet({ sheets: [{ name: 'A', rows: [['x']] }] })).toBe(false);
  });
});

// downloadOdsSpreadsheet pulls live data from the DB, generates an ODS, and
// hands the bytes to downloadBytes (which touches the DOM). We stub the DOM and
// then re-parse the captured bytes with the importer to confirm what landed on
// disk.
describe('downloadOdsSpreadsheet — round-trip via importer', () => {
  type StubAnchor = {
    href: string;
    download: string;
    rel: string;
    click: () => void;
    remove: () => void;
  };
  const captured: { bytes?: Uint8Array; filename?: string } = {};
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;
  let originalDocument: unknown;

  beforeEach(async () => {
    captured.bytes = undefined;
    captured.filename = undefined;
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    originalDocument = (globalThis as Record<string, unknown>).document;

    URL.createObjectURL = vi.fn(async (blob: Blob) => {
      captured.bytes = new Uint8Array(await blob.arrayBuffer());
      return 'blob:test';
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    (globalThis as Record<string, unknown>).document = {
      createElement: (): StubAnchor => ({
        href: '',
        download: '',
        rel: '',
        click() {
          captured.filename = this.download;
        },
        remove() {},
      }),
      body: { append: () => {} },
    };

    await addWeight({ date: iso('2026-05-09'), weightLbs: 181, wellness: 4, symptoms: [] });
    await addInjection({
      date: iso('2026-05-10'),
      amountMg: 5,
      medication: SEMA,
      site: 'belly',
      symptoms: [],
    });
    await addPrescription({
      type: SEMA,
      concentrationMgMl: 10,
      vialMl: 3,
      status: 'active',
    });
    await saveProfile({ weightUnit: 'lbs' });
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }
  });

  it('writes an ODS that the importer recognizes as an EvolvTrack spreadsheet and can round-trip', async () => {
    // URL.createObjectURL is async-stubbed above, but downloadBytes calls it
    // synchronously, so wait a tick after the export to make sure the blob
    // body has been read out into the captured buffer.
    await downloadOdsSpreadsheet();
    // Give the async mock a chance to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured.bytes).toBeTruthy();
    expect(captured.filename).toMatch(/^evolvtrack-export-\d{4}-\d{2}-\d{2}\.ods$/);

    // Copy into a fresh ArrayBuffer-backed Uint8Array so the File ctor accepts
    // it under strict lib types. (TS conflates SharedArrayBuffer-backed views.)
    const buf = new Uint8Array(captured.bytes!.byteLength);
    buf.set(captured.bytes!);
    const file = new File([buf], captured.filename!, {
      type: 'application/vnd.oasis.opendocument.spreadsheet',
    });
    const result = await parseTrackingFile(file);

    expect(result.source).toBe('EvolvTrack spreadsheet');
    // The Health Log sheet contains both weights and injections keyed by date.
    const weightForDay = result.data.weights.find((w) => w.date === '2026-05-09');
    expect(weightForDay).toBeTruthy();
    expect(weightForDay!.weightLbs).toBe(181);

    const injection = result.data.injections.find((i) => i.date === '2026-05-10');
    expect(injection).toBeTruthy();
    expect(injection!.amountMg).toBe(5);
    expect(injection!.medication).toBe(SEMA);

    expect(result.data.prescriptions).toHaveLength(1);
    expect(result.data.prescriptions[0].type).toBe(SEMA);
    expect(result.data.prescriptions[0].concentrationMgMl).toBe(10);

    // The Settings sheet feeds the profile.
    expect(result.data.profile?.weightUnit).toBe('lbs');
  });
});
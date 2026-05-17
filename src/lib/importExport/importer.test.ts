import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import {
  addInjection,
  addWeight,
  getAllInjections,
  getAllPrescriptions,
  getAllWeights,
  getProfile,
} from '$lib/domain/repo';
import {
  BACKUP_APP_ID,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
} from './backup';
import {
  emptyImportData,
  importResultSummary,
  importTrackingFile,
  parseTrackingFile,
} from './importer';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;

function jsonFile(name: string, payload: unknown): File {
  return new File([JSON.stringify(payload)], name, { type: 'application/json' });
}

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/csv' });
}

function backupPayload(overrides: { formatVersion?: number; weights?: unknown[]; injections?: unknown[]; prescriptions?: unknown[] } = {}) {
  return {
    app: BACKUP_APP_ID,
    kind: BACKUP_KIND,
    formatVersion: overrides.formatVersion ?? BACKUP_FORMAT_VERSION,
    appVersion: '0.0.3',
    dbSchemaVersion: 1,
    exportedAt: '2026-05-10T12:00:00.000Z',
    data: {
      weights: overrides.weights ?? [
        {
          id: 'w-1',
          date: '2026-05-10',
          weightLbs: 180,
          createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
      ],
      injections: overrides.injections ?? [
        {
          id: 'i-1',
          date: '2026-05-10',
          amountMg: 5,
          medication: SEMA,
          site: 'belly',
          symptoms: [],
          createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
      ],
      prescriptions: overrides.prescriptions ?? [],
    },
  };
}

describe('parseTrackingFile — backup JSON', () => {
  it('parses an EvolvTrack backup and reports the right source', async () => {
    const result = await parseTrackingFile(jsonFile('backup.json', backupPayload()));
    expect(result.source).toBe('EvolvTrack backup');
    expect(result.sourceDetail).toContain('backup v1');
    expect(result.data.weights).toHaveLength(1);
    expect(result.data.injections).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('warns when the backup format version is newer than supported', async () => {
    const result = await parseTrackingFile(
      jsonFile('newer.json', backupPayload({ formatVersion: BACKUP_FORMAT_VERSION + 1 })),
    );
    expect(result.warnings.some((w) => /format version/i.test(w))).toBe(true);
  });
});

describe('parseTrackingFile — external JSON', () => {
  it('extracts weights and injections from a flat array of rows', async () => {
    const payload = [
      { Date: '2026-05-09', Weight: 181, Wellness: 4, Symptoms: 'nausea, fatigue' },
      { Date: '2026-05-10', 'Dose (mg)': 5, Medication: 'Ozempic', 'Shot Location': 'belly' },
    ];
    const result = await parseTrackingFile(jsonFile('export.json', payload));
    expect(result.source).toBe('External JSON');
    expect(result.data.weights).toHaveLength(1);
    expect(result.data.weights[0]).toMatchObject({
      date: '2026-05-09',
      weightLbs: 181,
      wellness: 4,
      symptoms: ['nausea', 'fatigue'],
    });
    expect(result.data.injections).toHaveLength(1);
    expect(result.data.injections[0]).toMatchObject({
      date: '2026-05-10',
      amountMg: 5,
      medication: SEMA,
      site: 'belly',
    });
  });

  it('skips rows without a parseable date', async () => {
    const payload = [
      { Date: 'garbage', Weight: 200 },
      { Date: '2026-05-10', Weight: 180 },
    ];
    const result = await parseTrackingFile(jsonFile('mixed.json', payload));
    expect(result.data.weights).toHaveLength(1);
    expect(result.data.weights[0].date).toBe('2026-05-10');
  });

  it('emits a warning for an unrecognized medication and drops the medication value', async () => {
    const payload = [{ Date: '2026-05-10', 'Dose (mg)': 1, Medication: 'MysteryGLP' }];
    const result = await parseTrackingFile(jsonFile('weird.json', payload));
    expect(result.data.injections).toHaveLength(1);
    expect(result.data.injections[0].medication).toBe('');
    expect(result.warnings.join(' ')).toMatch(/Unrecognized medication "MysteryGLP"/);
  });

  it('rejects a JSON file with no recognizable rows', async () => {
    await expect(parseTrackingFile(jsonFile('empty.json', { something: 'else' }))).rejects.toThrow(
      /No compatible/,
    );
  });
});

describe('parseTrackingFile — CSV', () => {
  it('parses a CSV with weight and injection columns', async () => {
    const csv =
      'Date,Weight (lbs),Wellness,Dose (mg),Medication,Shot Location,Symptoms,Notes\n' +
      '2026-05-09,181,4,,,,,first day\n' +
      '2026-05-10,,,5,Ozempic,belly,nausea,after dinner\n';
    const result = await parseTrackingFile(csvFile('shotsy.csv', csv));
    expect(result.source).toBe('External CSV');
    expect(result.data.weights).toHaveLength(1);
    expect(result.data.weights[0]).toMatchObject({
      date: '2026-05-09',
      weightLbs: 181,
      notes: 'first day',
    });
    expect(result.data.injections).toHaveLength(1);
    expect(result.data.injections[0]).toMatchObject({
      date: '2026-05-10',
      amountMg: 5,
      medication: SEMA,
      site: 'belly',
    });
  });

  it('rejects an empty CSV', async () => {
    await expect(parseTrackingFile(csvFile('blank.csv', '   '))).rejects.toThrow(
      /No compatible/,
    );
  });

  it('converts a weight column tagged with kg to stored lbs', async () => {
    const csv = 'Date,Weight (kg)\n2026-05-10,80\n';
    const result = await parseTrackingFile(csvFile('kg.csv', csv));
    expect(result.data.weights).toHaveLength(1);
    expect(result.data.weights[0].weightLbs).toBeCloseTo(176.37, 1);
  });
});

describe('parseTrackingFile — unsupported / malformed', () => {
  it('throws on an unsupported extension', async () => {
    await expect(parseTrackingFile(new File(['x'], 'note.pdf'))).rejects.toThrow(/Unsupported/);
  });

  it('throws on malformed JSON', async () => {
    await expect(parseTrackingFile(new File(['{not json'], 'a.json'))).rejects.toThrow();
  });
});

describe('importTrackingFile — merge mode', () => {
  it('adds rows alongside existing data', async () => {
    await addWeight({ date: iso('2026-05-01'), weightLbs: 200 });
    await addInjection({
      date: iso('2026-05-01'),
      amountMg: 2,
      medication: SEMA,
      site: 'thigh',
      symptoms: [],
    });

    const result = await importTrackingFile(jsonFile('b.json', backupPayload()), 'merge');
    expect(result.mode).toBe('merge');
    expect(result.source).toBe('EvolvTrack backup');

    const weights = await getAllWeights();
    const injections = await getAllInjections();
    expect(weights).toHaveLength(2);
    expect(injections).toHaveLength(2);
    expect(weights.map((w) => w.date).sort()).toEqual(['2026-05-01', '2026-05-10']);
  });
});

describe('importTrackingFile — replace mode', () => {
  it('clears existing rows before applying the import', async () => {
    await addWeight({ date: iso('2026-05-01'), weightLbs: 200 });
    await addInjection({
      date: iso('2026-05-01'),
      amountMg: 2,
      medication: SEMA,
      site: 'thigh',
      symptoms: [],
    });

    const result = await importTrackingFile(jsonFile('b.json', backupPayload()), 'replace');
    expect(result.mode).toBe('replace');

    const weights = await getAllWeights();
    const injections = await getAllInjections();
    expect(weights).toHaveLength(1);
    expect(weights[0].date).toBe('2026-05-10');
    expect(injections).toHaveLength(1);
    expect(injections[0].date).toBe('2026-05-10');
  });

  it('writes parsed prescriptions into the DB', async () => {
    const payload = backupPayload({
      prescriptions: [
        {
          id: 'rx-1',
          type: SEMA,
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    });
    await importTrackingFile(jsonFile('b.json', payload), 'replace');
    const prescriptions = await getAllPrescriptions();
    expect(prescriptions).toHaveLength(1);
    expect(prescriptions[0].id).toBe('rx-1');
  });

  it('leaves the profile untouched when the import has no profile and is not an EvolvTrack source', async () => {
    // Seed a profile so we can confirm replace mode preserves it for external imports.
    const csv = 'Date,Weight (lbs)\n2026-05-10,180\n';
    // Start with a profile in the DB via a backup import...
    const seedPayload = {
      ...backupPayload(),
      data: {
        weights: [],
        injections: [],
        prescriptions: [],
        profile: {
          id: 'profile',
          passphraseEnabled: false,
          weightUnit: 'lbs',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    };
    await importTrackingFile(jsonFile('seed.json', seedPayload), 'replace');
    expect(await getProfile()).toBeTruthy();

    // ...then replace from a CSV which carries no profile data and is not an
    // EvolvTrack-branded source. The profile should remain.
    await importTrackingFile(csvFile('plain.csv', csv), 'replace');
    expect(await getProfile()).toBeTruthy();
  });
});

describe('importResultSummary', () => {
  it('describes a merged backup with sensible pluralization', () => {
    const summary = importResultSummary({
      mode: 'merge',
      source: 'EvolvTrack backup',
      sourceDetail: 'app 0.0.3, backup v1',
      data: {
        weights: [{} as never],
        injections: [{} as never, {} as never],
        prescriptions: [],
      },
    });
    expect(summary).toContain('Imported');
    expect(summary).toContain('1 weight entry');
    expect(summary).toContain('2 injections');
    expect(summary).toContain('0 medication rows');
    expect(summary).toContain('EvolvTrack backup');
    expect(summary).toContain('app 0.0.3');
  });

  it('uses "Replaced" wording for replace mode and adds settings when present', () => {
    const summary = importResultSummary({
      mode: 'replace',
      source: 'EvolvTrack spreadsheet',
      data: {
        weights: [],
        injections: [],
        prescriptions: [{} as never],
        profile: { id: 'profile' } as never,
      },
    });
    expect(summary).toContain('Replaced data with');
    expect(summary).toContain('1 medication row');
    expect(summary).toContain('settings');
  });
});

describe('emptyImportData', () => {
  it('returns an independent, empty ImportData shape', () => {
    const data = emptyImportData();
    expect(data).toEqual({ weights: [], injections: [], prescriptions: [] });
    data.weights.push({} as never);
    // A second call returns a fresh object that isn't polluted by the mutation.
    expect(emptyImportData().weights).toEqual([]);
  });
});

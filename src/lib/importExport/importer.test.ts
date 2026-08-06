import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { db } from '$lib/db/schema';
import { addEntry, getAllEntries, getAllPrescriptions, getProfile } from '$lib/domain/repo';
import { BACKUP_APP_ID, BACKUP_FORMAT_VERSION, BACKUP_KIND } from './backup';
import {
  dedupeAgainstExisting,
  emptyImportData,
  importResultSummary,
  importTrackingFile,
  parseTrackingFile,
} from './importer';
import type { ImportData } from './shared';
import type { HealthEntry } from '$lib/domain/types';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;

function jsonFile(name: string, payload: unknown): File {
  return new File([JSON.stringify(payload)], name, { type: 'application/json' });
}

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/csv' });
}

const weighInEntries = (data: ImportData) => data.entries.filter((e) => e.weightLbs != null);
const doseEntries = (data: ImportData) => data.entries.filter((e) => e.amountMg != null);

function backupPayload(overrides: { formatVersion?: number; entries?: unknown[]; prescriptions?: unknown[] } = {}) {
  return {
    app: BACKUP_APP_ID,
    kind: BACKUP_KIND,
    formatVersion: overrides.formatVersion ?? BACKUP_FORMAT_VERSION,
    appVersion: '0.0.3',
    dbSchemaVersion: 1,
    exportedAt: '2026-05-10T12:00:00.000Z',
    data: {
      entries: overrides.entries ?? [
        {
          id: 'w-1',
          date: '2026-05-10',
          weightLbs: 180,
          createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
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
    expect(result.data.entries).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('warns when the backup format version is newer than supported', async () => {
    const result = await parseTrackingFile(
      jsonFile('newer.json', backupPayload({ formatVersion: BACKUP_FORMAT_VERSION + 1 })),
    );
    expect(result.warnings.some((w) => /format version/i.test(w))).toBe(true);
  });

  it('rejects a recognized backup atomically when one Health Entry is invalid', async () => {
    const payload = backupPayload({
      entries: [
        backupPayload().data.entries[0],
        {
          id: 'invalid',
          date: '2026-02-30',
          weightLbs: 190,
          createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
      ],
    });
    await expect(parseTrackingFile(jsonFile('invalid-backup.json', payload))).rejects.toThrow(
      /No compatible/,
    );
  });
});

describe('parseTrackingFile — external JSON', () => {
  it('extracts weigh-in and dose entries from a flat array of rows', async () => {
    const payload = [
      { Date: '2026-05-09', Weight: 181, Wellness: 4, Symptoms: 'nausea, fatigue' },
      { Date: '2026-05-10', 'Dose (mg)': 5, Medication: 'Ozempic', 'Shot Location': 'belly' },
    ];
    const result = await parseTrackingFile(jsonFile('export.json', payload));
    expect(result.source).toBe('External JSON');
    expect(weighInEntries(result.data)[0]).toMatchObject({
      date: '2026-05-09',
      weightLbs: 181,
      wellness: 4,
      symptoms: ['nausea', 'fatigue'],
    });
    expect(doseEntries(result.data)[0]).toMatchObject({
      date: '2026-05-10',
      amountMg: 5,
      medication: SEMA,
      site: 'belly',
    });
  });

  it('does not mistake a third-party backup marker for an EvolvTrack backup', async () => {
    const payload = {
      kind: 'backup',
      rows: [{ Date: '2026-05-09', Weight: 181 }],
    };
    const result = await parseTrackingFile(jsonFile('external-backup.json', payload));
    expect(result.source).toBe('External JSON');
    expect(result.data.entries[0]).toMatchObject({ date: '2026-05-09', weightLbs: 181 });
  });

  it('skips rows without a parseable date', async () => {
    const payload = [
      { Date: 'garbage', Weight: 200 },
      { Date: '2026-05-10', Weight: 180 },
    ];
    const result = await parseTrackingFile(jsonFile('mixed.json', payload));
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].date).toBe('2026-05-10');
  });

  it('emits a warning for an unrecognized medication and drops the medication value', async () => {
    const payload = [{ Date: '2026-05-10', 'Dose (mg)': 1, Medication: 'MysteryGLP' }];
    const result = await parseTrackingFile(jsonFile('weird.json', payload));
    expect(doseEntries(result.data)).toHaveLength(1);
    expect(doseEntries(result.data)[0].medication).toBe('');
    expect(result.warnings.join(' ')).toMatch(/Unrecognized medication "MysteryGLP"/);
  });

  it('rejects a JSON file with no recognizable rows', async () => {
    await expect(parseTrackingFile(jsonFile('empty.json', { something: 'else' }))).rejects.toThrow(
      /No compatible/,
    );
  });

  it('rejects parsed external rows that violate the canonical domain', async () => {
    const payload = [{ Date: '2026-05-10', Weight: 180, Wellness: 11 }];
    await expect(parseTrackingFile(jsonFile('unsafe.json', payload))).rejects.toThrow(
      /No compatible/,
    );
  });
});

describe('parseTrackingFile — CSV', () => {
  it('parses a CSV with weight and dose columns', async () => {
    const csv =
      'Date,Weight (lbs),Wellness,Dose (mg),Medication,Shot Location,Symptoms,Notes\n' +
      '2026-05-09,181,4,,,,,first day\n' +
      '2026-05-10,,,5,Ozempic,belly,nausea,after dinner\n';
    const result = await parseTrackingFile(csvFile('shotsy.csv', csv));
    expect(result.source).toBe('External CSV');
    expect(weighInEntries(result.data)[0]).toMatchObject({
      date: '2026-05-09',
      weightLbs: 181,
      notes: 'first day',
    });
    expect(doseEntries(result.data)[0]).toMatchObject({
      date: '2026-05-10',
      amountMg: 5,
      medication: SEMA,
      site: 'belly',
    });
  });

  it('rejects an empty CSV', async () => {
    await expect(parseTrackingFile(csvFile('blank.csv', '   '))).rejects.toThrow(/No compatible/);
  });

  it('converts a weight column tagged with kg to stored lbs', async () => {
    const csv = 'Date,Weight (kg)\n2026-05-10,80\n';
    const result = await parseTrackingFile(csvFile('kg.csv', csv));
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].weightLbs).toBeCloseTo(176.37, 1);
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
    await addEntry({ date: iso('2026-05-01'), weightLbs: 200 });
    await addEntry({ date: iso('2026-05-01'), amountMg: 2, medication: SEMA, site: 'thigh' });

    const result = await importTrackingFile(jsonFile('b.json', backupPayload()), 'merge');
    expect(result.mode).toBe('merge');
    expect(result.source).toBe('EvolvTrack backup');

    const entries = await getAllEntries();
    expect(entries).toHaveLength(4);
    expect([...new Set(entries.map((e) => e.date))].sort()).toEqual(['2026-05-01', '2026-05-10']);
  });

  it('skips rows that duplicate existing data and reports them in the warnings', async () => {
    await addEntry({ date: iso('2026-05-10'), weightLbs: 180 });
    await addEntry({ date: iso('2026-05-10'), amountMg: 5, medication: SEMA, site: 'belly' });

    const result = await importTrackingFile(jsonFile('b.json', backupPayload()), 'merge');

    const entries = await getAllEntries();
    expect(entries).toHaveLength(2); // the imported duplicates were dropped
    expect(result.data.entries).toHaveLength(0); // reported counts reflect what was added
    expect(result.warnings.some((w) => /duplicate/i.test(w))).toBe(true);
  });
});

describe('dedupeAgainstExisting', () => {
  const weighIn = (date: string, weightLbs?: number): HealthEntry =>
    ({ id: `w-${date}-${weightLbs ?? 'x'}`, date: iso(date), weightLbs, symptoms: [], createdAt: 'c', updatedAt: 'u' });
  const dose = (date: string, amountMg: number, medication: string): HealthEntry =>
    ({ id: `i-${date}-${amountMg}-${medication}`, date: iso(date), amountMg, medication: medication as HealthEntry['medication'], site: '', symptoms: [], createdAt: 'c', updatedAt: 'u' });
  const data = (over: Partial<ImportData>): ImportData => ({ entries: [], prescriptions: [], ...over });

  it('drops an entry matching an existing day + value, keeps a different value', () => {
    const result = dedupeAgainstExisting(
      data({ entries: [weighIn('2026-05-10', 180), weighIn('2026-05-10', 190)] }),
      { entries: [weighIn('2026-05-10', 180)] },
    );
    expect(result.skipped).toBe(1);
    expect(result.data.entries.map((e) => e.weightLbs)).toEqual([190]);
  });

  it('drops an exact dose duplicate (day + amount + drug)', () => {
    const result = dedupeAgainstExisting(
      data({ entries: [dose('2026-05-10', 5, SEMA)] }),
      { entries: [dose('2026-05-10', 5, SEMA)] },
    );
    expect(result.skipped).toBe(1);
    expect(result.data.entries).toHaveLength(0);
  });

  it('keeps a dose with a different medication on the same day at the same amount', () => {
    const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';
    const result = dedupeAgainstExisting(
      data({ entries: [dose('2026-05-10', 5, TIRZ)] }),
      { entries: [dose('2026-05-10', 5, SEMA)] },
    );
    expect(result.skipped).toBe(0);
    expect(result.data.entries).toHaveLength(1);
  });

  it('dedupes identical entries within the same import batch', () => {
    const result = dedupeAgainstExisting(
      data({ entries: [weighIn('2026-05-10', 180), weighIn('2026-05-10', 180)] }),
      { entries: [] },
    );
    expect(result.data.entries).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
});

describe('importTrackingFile — replace mode', () => {
  it('clears existing rows before applying the import', async () => {
    await addEntry({ date: iso('2026-05-01'), weightLbs: 200 });
    await addEntry({ date: iso('2026-05-01'), amountMg: 2, medication: SEMA, site: 'thigh' });

    const result = await importTrackingFile(jsonFile('b.json', backupPayload()), 'replace');
    expect(result.mode).toBe('replace');

    const entries = await getAllEntries();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.date === '2026-05-10')).toBe(true);
  });

  it('writes parsed prescriptions into the DB', async () => {
    const payload = backupPayload({
      prescriptions: [
        { id: 'rx-1', type: SEMA, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
      ],
    });
    await importTrackingFile(jsonFile('b.json', payload), 'replace');
    const prescriptions = await getAllPrescriptions();
    expect(prescriptions).toHaveLength(1);
    expect(prescriptions[0].id).toBe('rx-1');
  });

  it('leaves the profile untouched when the import has no profile and is not an EvolvTrack source', async () => {
    const csv = 'Date,Weight (lbs)\n2026-05-10,180\n';
    const seedPayload = {
      ...backupPayload(),
      data: {
        entries: [],
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

    await importTrackingFile(csvFile('plain.csv', csv), 'replace');
    expect(await getProfile()).toBeTruthy();
  });
});

describe('importTrackingFile — outbox enqueue', () => {
  it('merge mode enqueues an upsert for every imported entry, prescription, and the profile', async () => {
    const payload = {
      ...backupPayload(),
      data: {
        ...backupPayload().data,
        prescriptions: [
          { id: 'rx-1', type: SEMA, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
        ],
        profile: {
          id: 'profile',
          passphraseEnabled: false,
          weightUnit: 'lbs',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    };
    await importTrackingFile(jsonFile('b.json', payload), 'merge');

    expect(await db.outbox.get('entry:w-1')).toMatchObject({ op: 'upsert' });
    expect(await db.outbox.get('entry:i-1')).toMatchObject({ op: 'upsert' });
    expect(await db.outbox.get('prescription:rx-1')).toMatchObject({ op: 'upsert' });
    const profileEntry = await db.outbox.get('profile:profile');
    expect(profileEntry).toMatchObject({ op: 'upsert' });
    expect((profileEntry!.payload as { passphraseEnabled: boolean }).passphraseEnabled).toBe(false);
  });

  it('replace mode enqueues delete tombstones for pre-existing rows that are not in the import', async () => {
    const oldWeight = await addEntry({ date: iso('2026-04-01'), weightLbs: 220 });
    const oldDose = await addEntry({ date: iso('2026-04-01'), amountMg: 1, medication: SEMA, site: 'thigh' });

    await importTrackingFile(jsonFile('b.json', backupPayload()), 'replace');

    expect(await db.outbox.get(`entry:${oldWeight.id}`)).toMatchObject({ op: 'delete', payload: null });
    expect(await db.outbox.get(`entry:${oldDose.id}`)).toMatchObject({ op: 'delete', payload: null });
    expect(await db.outbox.get('entry:w-1')).toMatchObject({ op: 'upsert' });
    expect(await db.outbox.get('entry:i-1')).toMatchObject({ op: 'upsert' });
  });

  it('registers symptoms not in the default palette so imported rows show in the dropdown and persist to the profile', async () => {
    const { DEFAULT_SYMPTOM_COLORS, symptomColors, symptomOptions } =
      await import('$lib/stores/symptomStore');
    const { getProfile } = await import('$lib/domain/repo');
    const { get } = await import('svelte/store');

    const payload = backupPayload({
      entries: [
        {
          id: 'w-sym',
          date: '2026-05-10',
          weightLbs: 180,
          symptoms: ['Nausea', 'Fatigue', 'Brain fog'],
          createdAt: '2026-05-10T12:00:00.000Z',
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
      ],
    });
    await importTrackingFile(jsonFile('b.json', payload), 'merge');

    const opts = get(symptomOptions);
    const colors = get(symptomColors);
    expect(opts).toContain('Fatigue');
    expect(opts).toContain('Brain fog');
    expect(colors['Fatigue']).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors['Brain fog']).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors['Nausea']).toBe(DEFAULT_SYMPTOM_COLORS['Nausea']);

    const profile = await getProfile();
    expect(profile?.symptomOptions).toEqual(expect.arrayContaining(['Fatigue', 'Brain fog']));
  });

  it('an import with both a profile block and new symptoms produces exactly one profile outbox entry', async () => {
    const payload = {
      ...backupPayload(),
      data: {
        ...backupPayload().data,
        entries: [
          {
            id: 'w-sym',
            date: '2026-05-10',
            weightLbs: 180,
            symptoms: ['Brain fog'],
            createdAt: '2026-05-10T12:00:00.000Z',
            updatedAt: '2026-05-10T12:00:00.000Z',
          },
        ],
        profile: {
          id: 'profile',
          passphraseEnabled: false,
          weightUnit: 'lbs',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    };
    await importTrackingFile(jsonFile('b.json', payload), 'merge');

    const profileOutboxRows = await db.outbox.where('aggregate').equals('profile').toArray();
    expect(profileOutboxRows).toHaveLength(1);

    const wirePayload = profileOutboxRows[0].payload as { weightUnit?: string; symptomOptions?: string[] };
    expect(wirePayload.weightUnit).toBe('lbs');
    expect(wirePayload.symptomOptions).toContain('Brain fog');
  });

  it('replace mode does not tombstone an id the import is re-inserting (the upsert wins)', async () => {
    await db.entries.put({
      id: 'w-1',
      date: iso('2026-04-01'),
      weightLbs: 999,
      symptoms: [],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    await importTrackingFile(jsonFile('b.json', backupPayload()), 'replace');

    expect(await db.outbox.get('entry:w-1')).toMatchObject({ op: 'upsert' });
  });
});

describe('importResultSummary', () => {
  it('describes a merged backup with sensible pluralization', () => {
    const summary = importResultSummary({
      mode: 'merge',
      source: 'EvolvTrack backup',
      sourceDetail: 'app 0.0.3, backup v1',
      data: {
        entries: [
          { weightLbs: 1 } as never,
          { amountMg: 1 } as never,
          { amountMg: 1 } as never,
        ],
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
        entries: [],
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
    expect(data).toEqual({ entries: [], prescriptions: [] });
    data.entries.push({} as never);
    expect(emptyImportData().entries).toEqual([]);
  });
});

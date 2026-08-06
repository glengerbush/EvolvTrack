import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { addEntry, getAllEntries } from '$lib/domain/repo';
import {
  BACKUP_APP_ID,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  createBackup,
  parseBackupPayload,
} from './backup';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;

describe('createBackup', () => {
  it('returns an empty-but-valid backup envelope when the DB is empty', async () => {
    const backup = await createBackup();
    expect(backup.app).toBe(BACKUP_APP_ID);
    expect(backup.kind).toBe(BACKUP_KIND);
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(backup.data).toEqual({
      entries: [],
      prescriptions: [],
      profile: undefined,
    });
  });

  it('includes existing entries from the DB', async () => {
    await addEntry({ date: iso('2026-05-10'), weightLbs: 180 });
    await addEntry({
      date: iso('2026-05-10'),
      amountMg: 5,
      medication: SEMA,
      site: 'belly',
    });

    const backup = await createBackup();
    expect(backup.data.entries).toHaveLength(2);
    expect(backup.data.entries.find((e) => e.weightLbs != null)).toMatchObject({
      date: '2026-05-10',
      weightLbs: 180,
    });
    expect(backup.data.entries.find((e) => e.amountMg != null)).toMatchObject({
      amountMg: 5,
      medication: SEMA,
    });

    // sanity check: repo returns the same rows we serialized
    expect(await getAllEntries()).toHaveLength(2);
  });
});

describe('parseBackupPayload', () => {
  function validPayload() {
    return {
      app: BACKUP_APP_ID,
      kind: BACKUP_KIND,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: '0.0.3',
      dbSchemaVersion: 1,
      exportedAt: '2026-05-10T12:00:00.000Z',
      data: {
        entries: [
          {
            id: 'w1',
            date: '2026-05-10',
            weightLbs: 180,
            createdAt: '2026-05-10T12:00:00.000Z',
            updatedAt: '2026-05-10T12:00:00.000Z',
          },
        ],
        prescriptions: [],
      },
    };
  }

  it('accepts a well-formed payload and returns the parsed structure', () => {
    const parsed = parseBackupPayload(validPayload());
    expect(parsed).not.toBeNull();
    expect(parsed!.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(parsed!.data.entries).toHaveLength(1);
  });

  it('returns null when the app field is wrong', () => {
    const payload = validPayload();
    payload.app = 'NotEvolvTrack' as never;
    expect(parseBackupPayload(payload)).toBeNull();
  });

  it('returns null when kind is wrong', () => {
    const payload = validPayload();
    payload.kind = 'export' as never;
    expect(parseBackupPayload(payload)).toBeNull();
  });

  it('returns null when formatVersion is missing or non-positive', () => {
    const payload = validPayload();
    (payload as Record<string, unknown>).formatVersion = 0;
    expect(parseBackupPayload(payload)).toBeNull();
  });

  it('returns null when required arrays are missing', () => {
    const payload = validPayload() as Record<string, unknown>;
    payload.data = { entries: [] }; // prescriptions missing
    expect(parseBackupPayload(payload)).toBeNull();
  });

  it('returns null for completely unrelated payloads', () => {
    expect(parseBackupPayload(null)).toBeNull();
    expect(parseBackupPayload({})).toBeNull();
    expect(parseBackupPayload('a string')).toBeNull();
  });

  it('rejects a backup containing a domain-invalid value', () => {
    const payload = validPayload();
    payload.data.entries[0].date = '2026-02-30';
    expect(parseBackupPayload(payload)).toBeNull();
  });
});

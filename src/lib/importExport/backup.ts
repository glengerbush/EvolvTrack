import { z } from 'zod';
import { APP_VERSION } from '$lib/version';
import { DB_SCHEMA_VERSION } from '$lib/db/schema';
import { getAllEntries, getAllPrescriptions, getProfile } from '$lib/domain/repo';
import type { HealthEntry, Prescription, ProfileSettings } from '$lib/domain/types';
import { canonicalDomain } from '$lib/domain/canonical-domain';
import { dateStamp, downloadText } from '$lib/importExport/download';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_APP_ID = 'EvolvTrack';
export const BACKUP_KIND = 'backup';

export type EvolvTrackBackup = {
  app: typeof BACKUP_APP_ID;
  kind: typeof BACKUP_KIND;
  formatVersion: number;
  appVersion: string;
  dbSchemaVersion: number;
  exportedAt: string;
  data: {
    entries: HealthEntry[];
    prescriptions: Prescription[];
    profile?: ProfileSettings;
  };
};

const backupSchema = z.object({
  app: z.literal(BACKUP_APP_ID),
  kind: z.literal(BACKUP_KIND),
  formatVersion: z.number().int().positive(),
  appVersion: z.string(),
  dbSchemaVersion: z.number(),
  exportedAt: z.string(),
  data: z.object({
    entries: z.array(z.unknown()),
    prescriptions: z.array(z.unknown()),
    profile: z.unknown().optional(),
  }),
});

export async function createBackup(): Promise<EvolvTrackBackup> {
  const [entries, prescriptions, profile] = await Promise.all([
    getAllEntries(),
    getAllPrescriptions(),
    getProfile(),
  ]);

  const backupProfile = profile
    ? canonicalDomain.serializeSyncableProfile(profile)
    : undefined;

  return {
    app: BACKUP_APP_ID,
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    dbSchemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      entries,
      prescriptions,
      profile: backupProfile,
    },
  };
}

export async function downloadBackup() {
  const backup = await createBackup();
  const filename = `evolvtrack-backup-${dateStamp()}.json`;
  downloadText(JSON.stringify(backup, null, 2), filename, 'application/json');
}

export function isEvolvTrackBackupEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return (payload as { app?: unknown }).app === BACKUP_APP_ID;
}

export function parseBackupPayload(payload: unknown): EvolvTrackBackup | null {
  const result = backupSchema.safeParse(payload);
  if (!result.success) return null;

  const parsed = canonicalDomain.parseCollections(result.data.data);
  if (!parsed.accepted) return null;

  return {
    ...result.data,
    data: parsed.value,
  };
}

import { z } from 'zod';
import { APP_VERSION } from '$lib/version';
import { DB_SCHEMA_VERSION } from '$lib/db/schema';
import { getAllInjections, getAllPrescriptions, getAllWeights, getProfile } from '$lib/domain/repo';
import type { InjectionEntry, Prescription, ProfileSettings, WeightEntry } from '$lib/domain/types';
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
    weights: WeightEntry[];
    injections: InjectionEntry[];
    prescriptions: Prescription[];
    profile?: ProfileSettings;
  };
};

const entitySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

const backupSchema = z.object({
  app: z.literal(BACKUP_APP_ID),
  kind: z.literal(BACKUP_KIND),
  formatVersion: z.number().int().positive(),
  appVersion: z.string(),
  dbSchemaVersion: z.number(),
  exportedAt: z.string(),
  data: z.object({
    weights: z.array(entitySchema),
    injections: z.array(entitySchema),
    prescriptions: z.array(entitySchema),
    profile: entitySchema.optional(),
  }),
});

export async function createBackup(): Promise<EvolvTrackBackup> {
  const [weights, injections, prescriptions, profile] = await Promise.all([
    getAllWeights(),
    getAllInjections(),
    getAllPrescriptions(),
    getProfile(),
  ]);

  return {
    app: BACKUP_APP_ID,
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    dbSchemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      weights,
      injections,
      prescriptions,
      profile,
    },
  };
}

export async function downloadBackup() {
  const backup = await createBackup();
  const filename = `evolvtrack-backup-${dateStamp()}.json`;
  downloadText(JSON.stringify(backup, null, 2), filename, 'application/json');
}

export function parseBackupPayload(payload: unknown): EvolvTrackBackup | null {
  const result = backupSchema.safeParse(payload);
  if (!result.success) return null;
  return result.data as unknown as EvolvTrackBackup;
}

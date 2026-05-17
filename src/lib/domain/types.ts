import type { ColorModePreference, ThemeName } from '$lib/theme/dashboardTheme';

export type EntityVersion = 1;

declare const isoDateBrand: unique symbol;
/**
 * ISO 8601 calendar date, `YYYY-MM-DD` (e.g. `"2025-09-01"`). Branded so the
 * compiler refuses plain strings; obtain one via `asIsoDate` or one of the
 * producers in `$lib/utils/dateKeys` (e.g. `localDateKey`, `addDays`).
 */
export type IsoDate = string & { readonly [isoDateBrand]: true };
/** ISO 8601 timestamp with timezone (e.g. `"2025-09-01T12:34:56.789Z"`). */
export type IsoDateTime = string;

export type WeightUnit = 'lbs' | 'kg';
export type SyncMode = 'plain' | 'migrating_to_e2ee' | 'e2ee' | 'migrating_to_plain';
export type SyncAggregate = 'weight' | 'injection' | 'prescription' | 'profile';
export type E2EEMigrationDirection = 'enable' | 'disable';

export interface E2EEMigrationState {
  id: string;
  direction?: E2EEMigrationDirection;
  ownerDeviceId: string;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  plaintextHighWaterMark?: IsoDateTime;
  completedAt?: IsoDateTime;
  encryptedEventCount?: number;
  plaintextEventCount?: number;
  deletedEncryptedEventCount?: number;
  lastError?: string;
}

export const MEDICATIONS = [
  'Semaglutide (Ozempic / Wegovy)',
  'Tirzepatide (Mounjaro / Zepbound)',
  'Dulaglutide (Trulicity)',
  'Liraglutide (Victoza / Saxenda)',
  'Retatrutide',
] as const;
export type Medication = (typeof MEDICATIONS)[number];

export function isMedication(value: unknown): value is Medication {
  return typeof value === 'string' && (MEDICATIONS as readonly string[]).includes(value);
}

export type PrescriptionStatus = 'warning' | 'active' | 'neutral';

export type DosageColKey =
  | 'type'
  | 'concentration'
  | 'additive'
  | 'mlInVial'
  | 'prescribedDosage'
  | 'dosesLeft';

export type VialColKey =
  | 'compoundDate'
  | 'bud'
  | 'lotNumber'
  | 'pharmacy'
  | 'cost'
  | 'costPerMg';

export type HealthColKey =
  | 'day'
  | 'date'
  | 'weight'
  | 'wellness'
  | 'symptoms'
  | 'system'
  | 'loss'
  | 'dose'
  | 'medication'
  | 'shotLocation'
  | 'notes';

export interface WeightEntry {
  id: string;
  date: IsoDate;
  weightLbs?: number;
  wellness?: number;
  systemMg?: number;
  symptoms?: string[];
  notes?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface InjectionEntry {
  id: string;
  date: IsoDate;
  amountMg: number;
  site: string;
  // Empty string is permitted for in-progress draft saves where the user
  // hasn't picked a medication yet; persisted rows should be a Medication.
  medication: Medication | '';
  symptoms: string[];
  notes?: string;
  planned?: boolean;
  confirmedAt?: IsoDateTime;
  skipped?: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Prescription {
  id: string;
  type?: Medication;
  compoundDate?: IsoDate;
  refillDate?: IsoDate;
  bud?: IsoDate;
  lotNumber?: string;
  concentrationMgMl?: number;
  vialMl?: number;
  prescribedDoseMg?: number;
  dosesLeft?: number;
  costUsd?: number;
  pharmacy?: string;
  additive?: string;
  status?: PrescriptionStatus;
  sortOrder?: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ProfileSettings {
  id: 'profile';
  startWeight?: number;
  goalWeight?: number;
  passphraseEnabled: boolean;
  syncMode?: SyncMode;
  e2eeMigration?: E2EEMigrationState;
  colorTheme?: ThemeName;
  colorModePreference?: ColorModePreference;
  weightUnit?: WeightUnit;
  dosageColOrder?: DosageColKey[];
  dosageHiddenCols?: DosageColKey[];
  vialColOrder?: VialColKey[];
  vialHiddenCols?: VialColKey[];
  healthColOrder?: HealthColKey[];
  healthHiddenCols?: HealthColKey[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface MigrationBackfillEntry {
  id: string;
  aggregate: SyncAggregate;
  op: 'upsert' | 'delete';
  payloadCiphertext: string;
  payloadIv: string;
  protocolVersion: number;
  encryptionVersion: number;
  schemaVersion: number;
  createdAt: IsoDateTime;
}

/**
 * A pending local change waiting to be pushed to the cloud. One row per
 * entity, keyed `${aggregate}:${entityId}` — repeated edits to the same
 * entity coalesce into a single row. `updatedAt` is the device-local edit
 * time (for upserts) or deletion time (for deletes); it is the clock used
 * for last-writer-wins conflict resolution. `payload` holds the full record
 * for an upsert and is `null` for a delete tombstone. `rev` is a fresh token
 * per enqueue: the push path deletes a row only if its `rev` is unchanged, so
 * a concurrent edit that landed mid-push is never silently dropped.
 */
export interface OutboxEntry {
  id: string;
  aggregate: SyncAggregate;
  entityId: string;
  op: 'upsert' | 'delete';
  updatedAt: IsoDateTime;
  payload: unknown;
  enqueuedAt: IsoDateTime;
  rev: string;
}

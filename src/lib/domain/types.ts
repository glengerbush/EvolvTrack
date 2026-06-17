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
export type SyncMode =
  | 'plain'
  | 'migrating_to_e2ee'
  | 'e2ee'
  | 'migrating_to_plain'
  | 'rotating_e2ee_key';
export type SyncAggregate = 'entry' | 'prescription' | 'profile';
export type E2EEMigrationDirection = 'enable' | 'disable' | 'rotate';

/**
 * A user's wrapped data encryption key, in both passphrase-wrapped and
 * recovery-code-wrapped form. Stored locally (single-row Dexie table keyed
 * `'self'`) and mirrored to `public.wrapped_keys` on the server. The local
 * copy enables same-device recovery when the cached session key was cleared
 * but the device is offline; the server copy enables new-device recovery.
 *
 * `dekVersion` bumps on every rotation. Once a record is encrypted under a
 * new DEK, any cached bundle from a stale version is rejected on the next
 * unlock so we never decrypt with a key that doesn't match the ciphertext.
 */
export interface WrappedKeyBundle {
  id: 'self';
  dekVersion: number;
  passphraseSaltB64: string;
  passphraseWrapped: { ciphertext: string; iv: string };
  /** PBKDF2 iterations the passphrase KEK was derived with. Stored so a raised
   *  work factor never locks out keys wrapped under the old one. */
  passphraseIterations: number;
  recoverySaltB64: string;
  recoveryWrapped: { ciphertext: string; iv: string };
  /** PBKDF2 iterations the recovery KEK was derived with (can differ from the
   *  passphrase half — e.g. after a recovery-code rotation). */
  recoveryIterations: number;
  updatedAt: IsoDateTime;
}

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
  /** Live progress of the current backfill, heartbeated by the owning device:
   * `recordsConverted` of `recordsTotal` re-encrypted so far. Other devices use
   * these (plus `updatedAt` freshness) to show a progress bar and detect a
   * stall. */
  recordsTotal?: number;
  recordsConverted?: number;
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

/**
 * A single health-log row — the unified record that replaces the old
 * weight/injection split. Each table row is exactly one `HealthEntry` with its
 * own id; nothing is merged by date, so a day can hold any number of entries
 * (multiple doses, weigh-ins, notes). A dose is present iff `amountMg != null`.
 */
export interface HealthEntry {
  id: string;
  date: IsoDate;
  // Weigh-in / day fields
  weightLbs?: number;
  wellness?: number;
  symptoms?: string[];
  notes?: string;
  // Dose fields (present when this row logs a dose)
  amountMg?: number;
  /** Empty string permitted for in-progress drafts; persisted doses are a Medication. */
  medication?: Medication | '';
  /** Shot location. */
  site?: string;
  /**
   * The vial this dose draws from (a `Prescription.id`). Auto-chosen by table
   * order when the dose is entered, then stored permanently so editing the
   * medications table never re-attributes it; the user can override it. The
   * dose drains exactly this vial (see `computeVialLevels` / `attributeVials`).
   * Absent = unassigned (drains no vial until one is attributed).
   */
  prescriptionId?: string;
  planned?: boolean;
  confirmedAt?: IsoDateTime;
  skipped?: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /**
   * Per-field last-writer-wins clocks. Optional for backward compatibility
   * with records written before per-field LWW landed; absent stamps fall back
   * to row `updatedAt` in `mergeRecord`. New writes always populate this for
   * every persistent field.
   */
  fieldUpdatedAt?: Record<string, IsoDateTime>;
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
  /**
   * Legacy manual "doses remaining" figure. Superseded by the computed vial
   * level (see `computeVialLevels`); retained for backward compatibility and as
   * a fallback when specs are incomplete. New edits write `manualMgUsed`.
   */
  dosesLeft?: number;
  /**
   * Manual correction (mg) added to a vial's computed consumption — e.g. doses
   * taken before logging began, or fixing a misattribution. Set when the user
   * edits the (otherwise auto-calculated) remaining cell. See `vialLevels.ts`.
   */
  manualMgUsed?: number;
  costUsd?: number;
  pharmacy?: string;
  additive?: string;
  status?: PrescriptionStatus;
  sortOrder?: number;
  /**
   * Hides a spent vial (typically once `dosesLeft` hits 0) from the medication
   * tables. Inventory/history is preserved — the row is still saved, synced,
   * and counted toward total spend; it's just filtered out of the default view
   * unless `ProfileSettings.showArchivedVials` is on.
   */
  archived?: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Per-field LWW clocks; see HealthEntry.fieldUpdatedAt for the format. */
  fieldUpdatedAt?: Record<string, IsoDateTime>;
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
  /** When true, archived (spent) vials are shown in the medication tables. */
  showArchivedVials?: boolean;
  healthColOrder?: HealthColKey[];
  healthHiddenCols?: HealthColKey[];
  /**
   * Symptom dropdown contents for this account. When defined, replaces the
   * built-in DEFAULT_SYMPTOM_OPTIONS wholesale — the user has explicitly
   * curated their list. When undefined (fresh account), the defaults apply.
   */
  symptomOptions?: string[];
  /**
   * Per-symptom hex color overrides. Merged on top of DEFAULT_SYMPTOM_COLORS
   * at read time, so the defaults remain a floor and only user-customized
   * entries need to be stored here.
   */
  symptomColors?: Record<string, string>;
  /**
   * Shot location dropdown contents. Same semantics as `symptomOptions`:
   * defined replaces the built-in defaults; undefined keeps them.
   */
  shotLocationOptions?: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /**
   * Per-field LWW clocks for syncable fields only. Device-local fields
   * (`passphraseEnabled`, `syncMode`, `e2eeMigration`) are excluded — they
   * never appear in this map and the merge ignores them.
   */
  fieldUpdatedAt?: Record<string, IsoDateTime>;
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

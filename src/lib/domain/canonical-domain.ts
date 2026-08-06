import { z } from 'zod';
import {
  DOSAGE_COL_KEYS,
  HEALTH_COL_KEYS,
  MEDICATIONS,
  PRESCRIPTION_STATUSES,
  VIAL_COL_KEYS,
  WEIGHT_UNITS,
  type HealthEntry,
  type Prescription,
  type ProfileSettings,
  type SyncAggregate,
} from './types';
import { COLOR_MODE_PREFERENCES, THEME_NAMES } from '$lib/theme/dashboardTheme';
import { asIsoDate } from '$lib/utils/dateKeys';

export type SyncableProfile = Omit<ProfileSettings, 'syncMode' | 'e2eeMigration'> & {
  passphraseEnabled: false;
};

type CanonicalDomainValues = {
  entry: HealthEntry;
  prescription: Prescription;
  profile: SyncableProfile;
};
export type CanonicalDomainParseResult<T> =
  | { accepted: true; value: T }
  | { accepted: false };
export type CanonicalDomainCollections = {
  entries: HealthEntry[];
  prescriptions: Prescription[];
  profile?: SyncableProfile;
};
export type CanonicalDomainCollectionsResult =
  | { accepted: true; value: CanonicalDomainCollections }
  | { accepted: false; aggregate: SyncAggregate };

const isoDateTime = z.string().datetime({ offset: true });

const isoDate = z.string().transform((value, context) => {
  const parsed = asIsoDate(value);
  if (parsed) return parsed;
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a real ISO calendar date.' });
  return z.NEVER;
});

function nullishToOptional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => value === null ? undefined : value, schema.optional());
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

function clocksFor(shape: z.ZodRawShape, excluded: readonly string[] = []) {
  const allowed = new Set(Object.keys(shape));
  for (const field of ['id', 'createdAt', 'updatedAt', ...excluded]) allowed.delete(field);
  return z.preprocess((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    return Object.fromEntries(
      Object.entries(input).filter(([field]) => allowed.has(field)),
    );
  }, z.record(isoDateTime)).optional();
}

const healthEntryShape = {
  id: z.string().min(1),
  date: isoDate,
  weightLbs: nullishToOptional(z.number().finite()),
  wellness: nullishToOptional(z.number().finite().min(0).max(10)),
  symptoms: nullishToOptional(z.array(z.string())),
  notes: nullishToOptional(z.string()),
  amountMg: nullishToOptional(z.number().finite()),
  medication: nullishToOptional(z.union([z.enum(MEDICATIONS), z.literal('')])),
  site: nullishToOptional(z.string()),
  prescriptionId: nullishToOptional(z.string()),
  planned: nullishToOptional(z.boolean()),
  confirmedAt: nullishToOptional(isoDateTime),
  skipped: nullishToOptional(z.boolean()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
} satisfies z.ZodRawShape;
const healthEntry = z.object({
  ...healthEntryShape,
  fieldUpdatedAt: clocksFor(healthEntryShape),
}).transform(withoutUndefined);

const vialShape = {
  id: z.string().min(1),
  type: nullishToOptional(z.enum(MEDICATIONS)),
  compoundDate: nullishToOptional(isoDate),
  refillDate: nullishToOptional(isoDate),
  bud: nullishToOptional(isoDate),
  lotNumber: nullishToOptional(z.string()),
  concentrationMgMl: nullishToOptional(z.number().finite()),
  vialMl: nullishToOptional(z.number().finite()),
  prescribedDoseMg: nullishToOptional(z.number().finite()),
  dosesLeft: nullishToOptional(z.number().finite()),
  manualMgUsed: nullishToOptional(z.number().finite()),
  costUsd: nullishToOptional(z.number().finite()),
  pharmacy: nullishToOptional(z.string()),
  additive: nullishToOptional(z.string()),
  status: nullishToOptional(z.enum(PRESCRIPTION_STATUSES)),
  sortOrder: nullishToOptional(z.number().finite()),
  archived: nullishToOptional(z.boolean()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
} satisfies z.ZodRawShape;
const vial = z.object({
  ...vialShape,
  fieldUpdatedAt: clocksFor(vialShape),
}).transform(withoutUndefined);

const syncableProfileShape = {
  id: z.literal('profile'),
  passphraseEnabled: z.unknown().optional().transform(() => false as const),
  startWeight: nullishToOptional(z.number().finite()),
  goalWeight: nullishToOptional(z.number().finite()),
  colorTheme: nullishToOptional(z.enum(THEME_NAMES)),
  colorModePreference: nullishToOptional(z.enum(COLOR_MODE_PREFERENCES)),
  weightUnit: nullishToOptional(z.enum(WEIGHT_UNITS)),
  dosageColOrder: nullishToOptional(z.array(z.enum(DOSAGE_COL_KEYS))),
  dosageHiddenCols: nullishToOptional(z.array(z.enum(DOSAGE_COL_KEYS))),
  vialColOrder: nullishToOptional(z.array(z.enum(VIAL_COL_KEYS))),
  vialHiddenCols: nullishToOptional(z.array(z.enum(VIAL_COL_KEYS))),
  showArchivedVials: nullishToOptional(z.boolean()),
  healthColOrder: nullishToOptional(z.array(z.enum(HEALTH_COL_KEYS))),
  healthHiddenCols: nullishToOptional(z.array(z.enum(HEALTH_COL_KEYS))),
  symptomOptions: nullishToOptional(z.array(z.string())),
  symptomColors: nullishToOptional(z.record(z.string())),
  shotLocationOptions: nullishToOptional(z.array(z.string())),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
} satisfies z.ZodRawShape;
const syncableProfile = z.object({
  ...syncableProfileShape,
  fieldUpdatedAt: clocksFor(syncableProfileShape, ['passphraseEnabled']),
}).transform(withoutUndefined);

function parse<A extends SyncAggregate>(
  aggregate: A,
  input: unknown,
): CanonicalDomainParseResult<CanonicalDomainValues[A]> {
  const result = aggregate === 'entry'
    ? healthEntry.safeParse(input)
    : aggregate === 'prescription'
      ? vial.safeParse(input)
      : syncableProfile.safeParse(input);
  return result.success
    ? { accepted: true, value: result.data as CanonicalDomainValues[A] }
    : { accepted: false };
}

function serializeSyncableProfile(profile: ProfileSettings): SyncableProfile {
  const parsed = parse('profile', profile);
  if (!parsed.accepted) throw new Error('The local profile is not syncable.');
  return parsed.value;
}

function parseCollections(input: {
  entries: readonly unknown[];
  prescriptions: readonly unknown[];
  profile?: unknown;
}): CanonicalDomainCollectionsResult {
  const entries: HealthEntry[] = [];
  for (const value of input.entries) {
    const parsed = parse('entry', value);
    if (!parsed.accepted) return { accepted: false, aggregate: 'entry' };
    entries.push(parsed.value);
  }

  const prescriptions: Prescription[] = [];
  for (const value of input.prescriptions) {
    const parsed = parse('prescription', value);
    if (!parsed.accepted) return { accepted: false, aggregate: 'prescription' };
    prescriptions.push(parsed.value);
  }

  const profile = input.profile === undefined ? undefined : parse('profile', input.profile);
  if (profile && !profile.accepted) return { accepted: false, aggregate: 'profile' };
  return { accepted: true, value: { entries, prescriptions, profile: profile?.value } };
}

export const canonicalDomain = { parse, parseCollections, serializeSyncableProfile };

import type { IsoDateTime, SyncAggregate } from './types';

/**
 * Per-field last-writer-wins for synced entities.
 *
 * The motivation is the field-loss problem in whole-row LWW: device A edits
 * `symptoms` offline, device B edits `wellness` offline, both push, the later
 * `updatedAt` wins the whole row and the other field-edit silently disappears.
 *
 * The fix is to clock each *field* independently. Every record carries an
 * optional `fieldUpdatedAt` sidecar mapping `fieldName -> IsoDateTime`. On
 * merge, each field is decided by comparing the two sides' field clocks; the
 * row-level `updatedAt` becomes `max(fieldUpdatedAt.*)` — kept for the outbox
 * and the pull cursor, but no longer the conflict resolver.
 *
 * Records produced by older clients have no `fieldUpdatedAt`; for those, every
 * field's clock falls back to the row's `updatedAt`. That gives the merge the
 * same behavior as legacy whole-row LWW, so the format is backward-compatible
 * in both directions.
 *
 * `id` and `createdAt` are immutable — never merged, always taken from local.
 */

const RESERVED = new Set(['id', 'createdAt', 'updatedAt', 'fieldUpdatedAt']);

export type Mergeable = {
  id: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  fieldUpdatedAt?: Record<string, IsoDateTime>;
};

/**
 * Caller-supplied keys to exclude from the merge entirely. Used by the profile
 * aggregate to keep its device-local state (`passphraseEnabled`, `syncMode`,
 * `e2eeMigration`) out of `fieldUpdatedAt` and unaffected by a pulled remote
 * — those fields never leave this device, so there's no per-field clock to
 * compare against, and a remote that "wins" on the row clock must not be
 * allowed to overwrite them.
 */
export type MergeOptions = { reserved?: ReadonlySet<string> };

function parseTime(value: IsoDateTime): number {
  return new Date(value).getTime();
}

function isMergedKey(key: string, reserved?: ReadonlySet<string>): boolean {
  return !RESERVED.has(key) && !reserved?.has(key);
}

function fieldKeys(record: object, reserved?: ReadonlySet<string>): string[] {
  return Object.keys(record).filter((k) => isMergedKey(k, reserved));
}

function fieldTime(record: Mergeable, field: string): IsoDateTime {
  const stamped = record.fieldUpdatedAt?.[field];
  if (stamped !== undefined) return stamped;
  // No per-field stamp for this field. If the record carries a sidecar at all,
  // the field was simply never set on it — so its clock is the record's birth
  // (`createdAt`), NOT the row's latest edit. Falling back to `updatedAt` here
  // is the bug behind "set a field on device A, it never lands on B": B's row
  // had no stamp for the new field, so the absent field inherited B's freshest
  // whole-row time and beat A's genuine first-time write (made worse by any
  // cross-device clock skew on that row time). Records with NO sidecar are
  // legacy whole-row-LWW writers: every field still falls back to `updatedAt`.
  return record.fieldUpdatedAt ? record.createdAt : record.updatedAt;
}

function maxIso(times: IsoDateTime[], fallback: IsoDateTime): IsoDateTime {
  let best = fallback;
  let bestT = parseTime(fallback);
  for (const t of times) {
    const tt = parseTime(t);
    if (tt > bestT) {
      best = t;
      bestT = tt;
    }
  }
  return best;
}

/**
 * Stamp `ts` onto every field present on `record` whose name isn't reserved.
 * Existing stamps are preserved unless overridden by the input set. Use this
 * on initial entity creation to seed a complete per-field clock — without it,
 * any later `updateEntry` that bumps row `updatedAt` would make absent stamps
 * silently jump forward via the fallback to row time.
 */
export function stampAllFields<T extends Mergeable>(
  record: T,
  ts: IsoDateTime,
  options: MergeOptions = {},
): T {
  const next: Record<string, IsoDateTime> = { ...(record.fieldUpdatedAt ?? {}) };
  // Strip any stale stamps for keys the caller now considers reserved (e.g.
  // a profile field that was previously synced but is now device-local).
  if (options.reserved) {
    for (const k of options.reserved) delete next[k];
  }
  for (const k of fieldKeys(record, options.reserved)) next[k] = ts;
  return { ...record, fieldUpdatedAt: next, updatedAt: ts };
}

/**
 * Apply a partial edit: bump `fieldUpdatedAt[field] = ts` for every patched
 * field, carry every other currently-present field's stamp forward (defaulting
 * to the pre-edit row time so a subsequent `updateEntry` bump can't make them
 * appear "newer"), and recompute row `updatedAt`. Returns the next field-clock
 * sidecar — callers also need to merge `patch` into the field values
 * themselves.
 */
export function bumpFieldStamps<T extends Mergeable>(
  record: T,
  patched: Iterable<string>,
  ts: IsoDateTime,
  options: MergeOptions = {},
): { fieldUpdatedAt: Record<string, IsoDateTime>; updatedAt: IsoDateTime } {
  const next: Record<string, IsoDateTime> = {};
  const baseline = record.updatedAt;
  const existing = record.fieldUpdatedAt ?? {};
  for (const k of fieldKeys(record, options.reserved)) {
    next[k] = existing[k] ?? baseline;
  }
  for (const k of patched) {
    if (isMergedKey(k, options.reserved)) next[k] = ts;
  }
  return { fieldUpdatedAt: next, updatedAt: maxIso(Object.values(next), ts) };
}

export type MergeResult<T extends Mergeable> = {
  /** Per-field LWW merge of `local` and `remote`. */
  merged: T;
  /**
   * At least one local field-time strictly beat the remote's, so the snapshot
   * we just pulled is missing data this device has. Callers should re-enqueue
   * `merged` to the outbox so the cloud catches up; otherwise a third device
   * pulling the same remote would never see the local-only fields.
   */
  localHasNews: boolean;
  /**
   * At least one remote field-time strictly beat the local's, so the local
   * row needs to be replaced with `merged`. If false, the merge is a no-op
   * against `local` and the caller can skip the table write.
   */
  remoteHasNews: boolean;
};

/**
 * Per-field LWW merge. See module doc for the format.
 *
 * Tie-breaking: when a field's two clocks are exactly equal, local wins —
 * matches the conservative `>` test used by the legacy whole-row path so a
 * pulled echo of our own write is a true no-op.
 */
export function mergeRecord<T extends Mergeable>(
  local: T,
  remote: T,
  options: MergeOptions = {},
): MergeResult<T> {
  const reserved = options.reserved;
  const fields = new Set<string>();
  for (const k of fieldKeys(local, reserved)) fields.add(k);
  for (const k of fieldKeys(remote, reserved)) fields.add(k);
  for (const k of Object.keys(local.fieldUpdatedAt ?? {})) {
    if (isMergedKey(k, reserved)) fields.add(k);
  }
  for (const k of Object.keys(remote.fieldUpdatedAt ?? {})) {
    if (isMergedKey(k, reserved)) fields.add(k);
  }

  const merged: Record<string, unknown> = { id: local.id, createdAt: local.createdAt };
  // Reserved fields are carried over from local unchanged; the remote can't
  // see them (sender stripped them on push) and they're device-local by
  // definition, so any "value" the remote might have for them is ignored.
  if (reserved) {
    for (const k of reserved) {
      if (k in local) merged[k] = (local as Record<string, unknown>)[k];
    }
  }

  const mergedTs: Record<string, IsoDateTime> = {};
  let localHasNews = false;
  let remoteHasNews = false;

  for (const f of fields) {
    const lt = fieldTime(local, f);
    const rt = fieldTime(remote, f);
    const ltN = parseTime(lt);
    const rtN = parseTime(rt);
    if (rtN > ltN) {
      if (f in remote) merged[f] = (remote as Record<string, unknown>)[f];
      mergedTs[f] = rt;
      remoteHasNews = true;
    } else {
      if (f in local) merged[f] = (local as Record<string, unknown>)[f];
      mergedTs[f] = lt;
      if (ltN > rtN) localHasNews = true;
    }
  }

  merged.fieldUpdatedAt = mergedTs;
  merged.updatedAt = maxIso(Object.values(mergedTs), local.updatedAt);

  return { merged: merged as T, localHasNews, remoteHasNews };
}

/**
 * Apply a patch onto a base record, treating `undefined` patch values as
 * field-clear tombstones — those keys are removed from the result rather
 * than left as `undefined`. This keeps the local row's shape identical to
 * the wire payload after `JSON.stringify` (which silently drops undefined
 * values), so a remote merging the push sees "field absent, stamp newer →
 * drop the field" symmetrically with the local apply.
 *
 * Pair with `bumpFieldStamps(merged, Object.keys(patch), ts)` to stamp the
 * cleared field — the stamp is what tells the remote merger that the
 * absence is intentional rather than legacy.
 */
export function applyPatchWithClears<T extends object>(
  base: T,
  // Wider than `Partial<T>` so `T` is inferred from `base` rather than from
  // the patch (which is typically `Partial<Omit<T, 'id' | 'createdAt'>>`).
  // The call sites' own signatures still enforce patch shape.
  patch: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === undefined) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Aggregates that use per-field LWW. Pull/apply consults this so the merge
 * path is opt-in per aggregate — other aggregates keep whole-row LWW until
 * they're individually migrated.
 */
export const MERGEABLE_AGGREGATES: ReadonlySet<SyncAggregate> = new Set<SyncAggregate>([
  'entry',
  'prescription',
]);

/**
 * Profile fields that live only on this device and never appear in the
 * outbox payload (see `toSyncableProfile` in repo.ts). The profile aggregate
 * keeps its own apply path because of this, but the merge itself uses the
 * `reserved` option so a pulled remote can't disturb them.
 */
export const PROFILE_DEVICE_LOCAL: ReadonlySet<string> = new Set([
  'passphraseEnabled',
  'syncMode',
  'e2eeMigration',
]);

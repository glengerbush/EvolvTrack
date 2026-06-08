import type { IsoDate } from '$lib/domain/types';

/**
 * Vial level math — the single source of truth for "how much is left in each
 * vial," derived from the vial specs plus the doses logged against that
 * medication. Never store the result; compute it (mirrors the pharmacokinetics
 * "mg in system" rule).
 *
 * Model decisions (see the medication-tab feature discussion):
 *  - Capacity is the *labeled* fill: `concentrationMgMl × vialMl`. We do not
 *    invent overfill capacity — a vial can deplete to zero and beyond, and the
 *    overage is surfaced honestly via `over` / a negative `mgLeft`.
 *  - Each dose is attributed to exactly one vial and drains its full mg from it
 *    (honest overfill if it exceeds the labeled fill — a dose is never split
 *    across vials). The attribution is stored per-dose (`prescriptionId`) and
 *    frozen once assigned, so reordering vials never moves a logged dose.
 *    Unassigned doses auto-attribute by *medication-table order* — the start
 *    vial is the one highest on the table (lowest `sortOrder`) that still has
 *    room (see `attributeVials`). Compound date is *not* used for attribution —
 *    only table position decides the auto-attribution order.
 *  - `manualMgUsed` is an additive correction to consumed mg for one vial (e.g.
 *    doses taken before logging began, or fixing a misattribution). It does NOT
 *    change FIFO room — it's applied after pouring — so the override stays
 *    predictable and non-circular with the back-solve at the edit site.
 */

export type VialSpec = {
  id: string;
  /** The medication this vial holds (`Prescription.type`); '' when unset. */
  medication: string;
  concentrationMgMl?: number;
  vialMl?: number;
  prescribedDoseMg?: number;
  compoundDate?: IsoDate;
  sortOrder?: number;
  createdAt: string;
  /** Manual correction (mg) added to computed consumption for this vial. */
  manualMgUsed?: number;
};

export type DoseEvent = {
  /** Stable id of the source entry; used to key per-dose vial attribution. */
  id?: string;
  medication: string;
  amountMg: number;
  date: IsoDate;
  createdAt?: string;
  /**
   * Manual per-dose vial attribution override (a vial `id`). When set and the
   * target vial belongs to this dose's medication, the dose's full mg are
   * poured into that vial instead of following the medication-table FIFO order.
   */
  prescriptionId?: string;
};

export type VialLevel = {
  /** Labeled capacity (`concentration × mL`), or null when specs are incomplete. */
  mgCapacity: number | null;
  /** mg attributed to this vial by FIFO from logged doses (excludes the manual correction). */
  mgUsedFromDoses: number;
  /** Total consumed = FIFO doses + manual correction. */
  mgUsed: number;
  /** Capacity − used. Not clamped: negative means used past the labeled fill. */
  mgLeft: number | null;
  /** `max(0, mgLeft)` — the headline figure. */
  mgLeftClamped: number | null;
  /** `mgLeftClamped / prescribedDoseMg`, or null when no dose size is set. */
  dosesLeft: number | null;
  /** True once consumption exceeds the labeled capacity (into overfill). */
  over: boolean;
};

const EPS = 1e-9;

function capacityOf(v: VialSpec): number | null {
  const c = v.concentrationMgMl;
  const m = v.vialMl;
  if (!c || !m || c <= 0 || m <= 0) return null;
  return c * m;
}

// Medication-table order: drain the vial highest on the table first. Ascending
// `sortOrder` (the display order from `sortPrescriptionsByDisplayOrder`),
// missing sortOrder last, then createdAt, then id — fully deterministic.
// Compound date is intentionally ignored: attribution follows table position.
function compareVials(a: VialSpec, b: VialSpec): number {
  const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
  const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareDoses(a: DoseEvent, b: DoseEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ac = a.createdAt ?? '';
  const bc = b.createdAt ?? '';
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}

function levelFor(v: VialSpec, cap: number, fromDoses: number): VialLevel {
  const used = fromDoses + (v.manualMgUsed ?? 0);
  const mgLeft = cap - used;
  const clamped = Math.max(0, mgLeft);
  const doseSize = v.prescribedDoseMg && v.prescribedDoseMg > 0 ? v.prescribedDoseMg : null;
  return {
    mgCapacity: cap,
    mgUsedFromDoses: fromDoses,
    mgUsed: used,
    mgLeft,
    mgLeftClamped: clamped,
    dosesLeft: doseSize ? clamped / doseSize : null,
    over: used > cap + EPS,
  };
}

/**
 * Compute the level of every vial, keyed by vial id, purely from each dose's
 * stored vial attribution (`DoseEvent.prescriptionId`) — no FIFO, no splitting,
 * no auto-guessing. A dose drains exactly the vial it's attributed to (full mg,
 * honest overfill if it exceeds the labeled fill); a dose with no attribution
 * (or one pointing at a missing / different-medication / incomplete-spec vial)
 * drains nothing — it's "unassigned" until the user picks a vial. Attribution is
 * assigned once and frozen (see `attributeVials`), so reordering vials or editing
 * the medications table never moves a dose's consumption. Doses must already be
 * filtered to those that consumed product (confirmed, not skipped/planned) — see
 * `isConsumingDose`.
 */
export function computeVialLevels(
  vials: VialSpec[],
  doses: DoseEvent[],
): Map<string, VialLevel> {
  const result = new Map<string, VialLevel>();
  const vialById = new Map<string, VialSpec>();
  for (const v of vials) vialById.set(v.id, v);

  // Pour each dose into exactly its attributed vial.
  const poured = new Map<string, number>();
  for (const d of doses) {
    if (!(d.amountMg > 0) || !d.prescriptionId) continue;
    const v = vialById.get(d.prescriptionId);
    // The attribution must point at a complete-spec vial of the dose's drug;
    // anything else is treated as unassigned (drains nothing).
    if (!v || capacityOf(v) == null || v.medication !== d.medication) continue;
    poured.set(d.prescriptionId, (poured.get(d.prescriptionId) ?? 0) + d.amountMg);
  }

  for (const v of vials) {
    const cap = capacityOf(v);
    if (cap == null) {
      result.set(v.id, {
        mgCapacity: null,
        mgUsedFromDoses: 0,
        mgUsed: v.manualMgUsed ?? 0,
        mgLeft: null,
        mgLeftClamped: null,
        dosesLeft: null,
        over: false,
      });
      continue;
    }
    result.set(v.id, levelFor(v, cap, poured.get(v.id) ?? 0));
  }

  return result;
}

/**
 * Given a vial's current FIFO consumption and labeled capacity, the
 * `manualMgUsed` correction that makes its remaining equal `desiredMgLeft`.
 * Used when the user types a value into the (overridable) remaining cell.
 */
export function manualMgUsedForDesiredLeft(
  mgCapacity: number,
  mgUsedFromDoses: number,
  desiredMgLeft: number,
): number {
  return mgCapacity - mgUsedFromDoses - desiredMgLeft;
}

export type VialAttribution = {
  /** The vial this dose draws from. */
  vialId: string;
  /** True when chosen by FIFO (no stored override) — i.e. not yet frozen. */
  auto: boolean;
};

/**
 * The vial each consuming dose draws from, keyed by `DoseEvent.id`:
 *  - a dose with a valid stored `prescriptionId` maps to it (`auto: false`);
 *  - otherwise the medication-table FIFO start vial (the first vial with room),
 *    matching `computeVialLevels` (`auto: true`).
 * Lets the UI always show the dose's vial number, and lets the inputs table
 * freeze the `auto` ones into a permanent `prescriptionId`. A dose larger than a
 * vial's room maps to that one vial (no split) — see `computeVialLevels`.
 */
export function attributeVials(
  vials: VialSpec[],
  doses: DoseEvent[],
): Map<string, VialAttribution> {
  const result = new Map<string, VialAttribution>();
  const validByMed = new Map<string, VialSpec[]>();
  for (const v of vials) {
    if (capacityOf(v) == null) continue;
    const list = validByMed.get(v.medication) ?? [];
    list.push(v);
    validByMed.set(v.medication, list);
  }

  const dosesByMed = new Map<string, DoseEvent[]>();
  for (const d of doses) {
    if (!(d.amountMg > 0)) continue;
    const list = dosesByMed.get(d.medication) ?? [];
    list.push(d);
    dosesByMed.set(d.medication, list);
  }

  for (const [med, vialListRaw] of validByMed) {
    const vialList = vialListRaw.slice().sort(compareVials);
    const vialIds = new Set(vialList.map((v) => v.id));
    const capById = new Map(vialList.map((v) => [v.id, capacityOf(v)!]));
    const medDoses = (dosesByMed.get(med) ?? []).slice().sort(compareDoses);

    // Consumption already locked in by attributed (stored-prescriptionId) doses,
    // plus those doses in date order for the "next attributed dose" lookup.
    const frozenTotal = new Map<string, number>();
    const frozenByDate: DoseEvent[] = [];
    for (const dose of medDoses) {
      if (dose.prescriptionId && vialIds.has(dose.prescriptionId)) {
        frozenTotal.set(dose.prescriptionId, (frozenTotal.get(dose.prescriptionId) ?? 0) + dose.amountMg);
        frozenByDate.push(dose);
        if (dose.id) result.set(dose.id, { vialId: dose.prescriptionId, auto: false });
      }
    }

    const autoAssigned = new Map<string, number>();
    const roomOf = (id: string) =>
      (capById.get(id) ?? 0) - (frozenTotal.get(id) ?? 0) - (autoAssigned.get(id) ?? 0);

    for (const dose of medDoses) {
      if (dose.prescriptionId && vialIds.has(dose.prescriptionId)) continue; // already attributed
      // The temporally-appropriate vial = the one the next attributed dose uses
      // (so a dose inserted into the past lands in the vial active *then*). With
      // no later attributed dose this is the current/latest dose, whose vial is
      // the first (table order) that still has room.
      const nextAttributed = frozenByDate.find((f) => compareDoses(f, dose) > 0);
      const candidate = nextAttributed
        ? nextAttributed.prescriptionId
        : vialList.find((v) => roomOf(v.id) > EPS)?.id;
      // Only auto-assign when that vial still has capacity; otherwise leave the
      // dose unattributed for the user to decide (e.g. a past dose whose vial was
      // already drained by later doses).
      if (candidate && roomOf(candidate) > EPS) {
        if (dose.id) result.set(dose.id, { vialId: candidate, auto: true });
        autoAssigned.set(candidate, (autoAssigned.get(candidate) ?? 0) + dose.amountMg);
      }
    }
  }

  return result;
}

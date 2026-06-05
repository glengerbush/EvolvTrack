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
 *  - Doses are attributed by *medication-table order*: the vial highest on the
 *    table (lowest `sortOrder`) for that drug is drained first, and a dose that
 *    exceeds what's left *splits* — the remainder is drawn from the next vial
 *    down (matching the vial-transition calculator). So a dose "starts coming
 *    from the next vial" exactly when the current vial can't cover it. Compound
 *    date is *not* used for attribution — only table position decides the order.
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
  medication: string;
  amountMg: number;
  date: IsoDate;
  createdAt?: string;
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
 * Compute the level of every vial, keyed by vial id. Doses must already be
 * filtered to those that actually consumed product (confirmed, not skipped or
 * merely planned) — see `isConsumingDose`.
 */
export function computeVialLevels(
  vials: VialSpec[],
  doses: DoseEvent[],
): Map<string, VialLevel> {
  const result = new Map<string, VialLevel>();
  const validByMed = new Map<string, VialSpec[]>();

  for (const v of vials) {
    const cap = capacityOf(v);
    if (cap == null) {
      // Incomplete specs: can't place it in the FIFO chain or compute a level.
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

  for (const [med, vialList] of validByMed) {
    vialList.sort(compareVials);
    const medDoses = (dosesByMed.get(med) ?? []).slice().sort(compareDoses);
    const poured = new Map<string, number>();
    let idx = 0;

    for (const dose of medDoses) {
      let remaining = dose.amountMg;
      while (remaining > EPS && idx < vialList.length) {
        const v = vialList[idx];
        const cap = capacityOf(v)!;
        const already = poured.get(v.id) ?? 0;
        const room = cap - already;
        if (room <= EPS) {
          idx += 1;
          continue;
        }
        const take = Math.min(room, remaining);
        poured.set(v.id, already + take);
        remaining -= take;
        if (room - take <= EPS) idx += 1;
      }
      if (remaining > EPS && vialList.length) {
        // Past the last vial — overfill territory. Pile the remainder onto the
        // last vial so the overage shows there instead of vanishing.
        const last = vialList[vialList.length - 1];
        poured.set(last.id, (poured.get(last.id) ?? 0) + remaining);
      }
    }

    for (const v of vialList) {
      result.set(v.id, levelFor(v, capacityOf(v)!, poured.get(v.id) ?? 0));
    }
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

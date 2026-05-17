import { writable } from 'svelte/store';

const STORAGE_KEY = 'evolvtrack:dismissedReminders';
const MAX_AGE_DAYS = 90;

export type BudDismissal = { bud: string; dismissedAt: string };
export type RefillDismissal = { atDoses: number; dismissedAt: string };

export type DismissedReminders = {
  bud: Record<string, BudDismissal>;
  refill: Record<string, RefillDismissal>;
};

const empty = (): DismissedReminders => ({ bud: {}, refill: {} });

function isBudDismissal(v: unknown): v is BudDismissal {
  return !!v && typeof v === 'object'
    && typeof (v as BudDismissal).bud === 'string'
    && typeof (v as BudDismissal).dismissedAt === 'string';
}

function isRefillDismissal(v: unknown): v is RefillDismissal {
  return !!v && typeof v === 'object'
    && typeof (v as RefillDismissal).atDoses === 'number'
    && typeof (v as RefillDismissal).dismissedAt === 'string';
}

function load(): DismissedReminders {
  if (typeof window === 'undefined') return empty();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<DismissedReminders>;
    const out = empty();
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(parsed.bud ?? {})) {
      if (isBudDismissal(v) && Date.parse(v.dismissedAt) >= cutoff) out.bud[k] = v;
    }
    for (const [k, v] of Object.entries(parsed.refill ?? {})) {
      if (isRefillDismissal(v) && Date.parse(v.dismissedAt) >= cutoff) out.refill[k] = v;
    }
    return out;
  } catch {
    return empty();
  }
}

function persist(state: DismissedReminders) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private mode, quota); fail silently.
  }
}

const _store = writable<DismissedReminders>(load());

export const dismissedReminders = {
  subscribe: _store.subscribe,

  dismissBud(dbId: string, bud: string) {
    _store.update((s) => {
      const next = { ...s, bud: { ...s.bud, [dbId]: { bud, dismissedAt: new Date().toISOString() } } };
      persist(next);
      return next;
    });
  },

  restoreAll() {
    const next = empty();
    persist(next);
    _store.set(next);
  },

  dismissRefill(type: string, atDoses: number) {
    _store.update((s) => {
      const next = {
        ...s,
        refill: { ...s.refill, [type]: { atDoses, dismissedAt: new Date().toISOString() } },
      };
      persist(next);
      return next;
    });
  },

  /**
   * Drop dismissals whose underlying entity no longer exists, plus any refill
   * dismissals where supply has recovered above the threshold (so the next
   * dip re-fires). Called opportunistically; safe to no-op when inputs empty.
   */
  reconcile(args: {
    knownPrescriptionIds: Set<string>;
    refillSupplyByType: Map<string, number>;
    refillThreshold: number;
  }) {
    _store.update((s) => {
      const bud: Record<string, BudDismissal> = {};
      for (const [id, entry] of Object.entries(s.bud)) {
        if (args.knownPrescriptionIds.has(id)) bud[id] = entry;
      }
      const refill: Record<string, RefillDismissal> = {};
      for (const [type, entry] of Object.entries(s.refill)) {
        const supply = args.refillSupplyByType.get(type);
        if (supply === undefined) continue;
        if (supply >= args.refillThreshold) continue;
        refill[type] = entry;
      }
      const next = { bud, refill };
      const changed =
        Object.keys(bud).length !== Object.keys(s.bud).length ||
        Object.keys(refill).length !== Object.keys(s.refill).length;
      if (changed) persist(next);
      return changed ? next : s;
    });
  },
};

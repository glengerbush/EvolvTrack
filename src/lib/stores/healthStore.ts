import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import { db } from '$lib/db/schema';
import { onHealthDataChange, type HealthDataChange } from '$lib/domain/repo';
import type { WeightEntry, InjectionEntry } from '$lib/domain/types';
import type { HealthInputRow, HealthSystemAmount } from '$lib/stores/healthTypes';
import { calculateSystemMgByDrug, KG_PER_LB, type WeighIn } from '$lib/utils/pharmacokinetics';
import { enrichSystemAmounts, formatSystemAmounts } from '$lib/utils/healthRowDerived';

export type RawHealthData = { weights: WeightEntry[]; injections: InjectionEntry[] };

function upsert<T extends { id: string }>(arr: T[], entity: T): T[] {
  const idx = arr.findIndex((e) => e.id === entity.id);
  if (idx === -1) return [...arr, entity];
  const next = arr.slice();
  next[idx] = entity;
  return next;
}

export function applyHealthChange(state: RawHealthData, change: HealthDataChange): RawHealthData {
  if (change.kind === 'weight') {
    switch (change.action) {
      case 'add':
        return { ...state, weights: upsert(state.weights, change.entity) };
      case 'patch':
        return {
          ...state,
          weights: state.weights.map((w) => (w.id === change.id ? { ...w, ...change.patch } : w)),
        };
      case 'delete':
        return { ...state, weights: state.weights.filter((w) => w.id !== change.id) };
      case 'reset':
        return { ...state, weights: [] };
    }
  }
  switch (change.action) {
    case 'add':
      return { ...state, injections: upsert(state.injections, change.entity) };
    case 'patch':
      return {
        ...state,
        injections: state.injections.map((i) =>
          i.id === change.id ? { ...i, ...change.patch } : i,
        ),
      };
    case 'bulkPatch': {
      if (change.ids.length === 0) return state;
      const targets = new Set(change.ids);
      return {
        ...state,
        injections: state.injections.map((i) =>
          targets.has(i.id) ? { ...i, ...change.patch } : i,
        ),
      };
    }
    case 'delete':
      return { ...state, injections: state.injections.filter((i) => i.id !== change.id) };
    case 'reset':
      return { ...state, injections: [] };
  }
}

const rawHealthData = writable<RawHealthData>({ weights: [], injections: [] });

// Resolves once the initial Dexie load has populated `rawHealthData`.
// Callers (tests, UI spinners, SSR skeletons) can `await` this instead of
// guessing how many event-loop ticks it takes for the load to settle.
export let healthStoreReady: Promise<void> = Promise.resolve();

if (browser) {
  // Buffer mutations that happen before the initial load resolves so they
  // aren't overwritten when the snapshot lands.
  let loaded = false;
  const pendingChanges: HealthDataChange[] = [];

  onHealthDataChange((change) => {
    if (!loaded) {
      pendingChanges.push(change);
      return;
    }
    rawHealthData.update((s) => applyHealthChange(s, change));
  });

  healthStoreReady = Promise.all([db.weights.toArray(), db.injections.toArray()])
    .then(([weights, injections]) => {
      let next: RawHealthData = { weights, injections };
      for (const change of pendingChanges) next = applyHealthChange(next, change);
      pendingChanges.length = 0;
      loaded = true;
      rawHealthData.set(next);
    })
    .catch((err) => {
      console.error('Failed to load health data:', err);
    });
}

function normalizeInjections(injections: InjectionEntry[]) {
  let lastKnownMedication = '';
  return [...injections]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .filter((inj) => Number.isFinite(inj.amountMg) && inj.amountMg > 0 && inj.skipped !== true)
    .map((inj) => {
      const medication = inj.medication || lastKnownMedication;
      if (inj.medication) lastKnownMedication = inj.medication;
      return { date: inj.date, amountMg: inj.amountMg, medication };
    })
    .filter((inj) => inj.medication);
}

function buildRows(weights: WeightEntry[], injections: InjectionEntry[]): HealthInputRow[] {
  const orderedWeights = [...weights].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const orderedInjections = [...injections].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
  );
  const weightsByDate = new Map<string, WeightEntry[]>();
  for (const weight of orderedWeights) {
    const dateWeights = weightsByDate.get(weight.date) ?? [];
    dateWeights.push(weight);
    weightsByDate.set(weight.date, dateWeights);
  }

  const injectionsByDate = new Map<string, InjectionEntry[]>();
  for (const inj of orderedInjections) {
    const dateInjections = injectionsByDate.get(inj.date) ?? [];
    dateInjections.push(inj);
    injectionsByDate.set(inj.date, dateInjections);
  }

  const dates = new Set([...weights.map((w) => w.date), ...injections.map((i) => i.date)]);
  const injectionSnapshot = normalizeInjections(injections);
  const showMedicationLetters = new Set(injectionSnapshot.map((inj) => inj.medication)).size > 1;

  const weighIns: WeighIn[] = [];
  for (const w of weights) {
    if (w.weightLbs != null) weighIns.push({ date: w.date, weightKg: w.weightLbs * KG_PER_LB });
  }

  return [...dates].sort().flatMap((date) => {
    const dateWeights = weightsByDate.get(date) ?? [];
    const dateInjections = injectionsByDate.get(date) ?? [];
    const systemAmounts = enrichSystemAmounts(calculateSystemMgByDrug(injectionSnapshot, date, weighIns));

    const makeRow = (inj?: InjectionEntry, w?: WeightEntry): HealthInputRow => ({
      weightId: w?.id,
      injectionId: inj?.id,
      day: '',
      date,
      system: inj?.skipped === true ? '' : formatSystemAmounts(systemAmounts, showMedicationLetters),
      systemAmounts: inj?.skipped === true ? [] : systemAmounts,
      dose: inj?.amountMg != null ? String(inj.amountMg) : '',
      dosePlanned: inj?.planned === true,
      doseConfirmedAt: inj?.confirmedAt,
      doseSkipped: inj?.skipped === true,
      medication: inj?.medication ?? '',
      weight: w?.weightLbs != null ? String(w.weightLbs) : '',
      wellness: w?.wellness != null ? String(w.wellness) : '',
      loss: '',
      symptoms: w ? w.symptoms ?? inj?.symptoms ?? [] : inj?.symptoms ?? [],
      shotLocation: inj?.site ?? '',
      notes: w ? w.notes ?? inj?.notes ?? '' : inj?.notes ?? '',
    });

    const rowCount = Math.max(dateWeights.length, dateInjections.length, 1);
    return Array.from({ length: rowCount }, (_, index) =>
      makeRow(dateInjections[index], dateWeights[index]),
    );
  });
}

export const healthEntries = derived(rawHealthData, ($d) =>
  buildRows($d.weights, $d.injections),
);

export const latestWeightLbs = derived(rawHealthData, ($d) => {
  // `$d.weights` is in insertion order, not date order (it's seeded from
  // `db.weights.toArray()` and `upsert` appends), so we can't just take the
  // last element. Pick the weighed entry with the latest date, tie-broken by
  // `createdAt`. Symmetric with `earliestWeightLbs` below.
  const weighed = $d.weights.filter((w) => w.weightLbs != null);
  if (weighed.length === 0) return null;
  const latest = weighed.reduce((acc, w) =>
    w.date > acc.date || (w.date === acc.date && w.createdAt > acc.createdAt) ? w : acc,
  );
  return latest.weightLbs ?? null;
});

export const earliestWeightLbs = derived(rawHealthData, ($d) => {
  const weighed = $d.weights.filter((w) => w.weightLbs != null);
  if (weighed.length === 0) return null;
  const earliest = weighed.reduce((acc, w) =>
    w.date < acc.date || (w.date === acc.date && w.createdAt < acc.createdAt) ? w : acc,
  );
  return earliest.weightLbs ?? null;
});

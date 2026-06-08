import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import { db } from '$lib/db/schema';
import { onHealthDataChange, type HealthDataChange } from '$lib/domain/repo';
import type { HealthEntry } from '$lib/domain/types';
import type { HealthInputRow, HealthSystemAmount } from '$lib/stores/healthTypes';
import { calculateSystemMgByDrug, KG_PER_LB, type WeighIn } from '$lib/utils/pharmacokinetics';
import {
  averageWeightLbsByDate,
  enrichSystemAmounts,
  formatSystemAmounts,
} from '$lib/utils/healthRowDerived';

export type RawHealthData = { entries: HealthEntry[] };

function upsert<T extends { id: string }>(arr: T[], entity: T): T[] {
  const idx = arr.findIndex((e) => e.id === entity.id);
  if (idx === -1) return [...arr, entity];
  const next = arr.slice();
  next[idx] = entity;
  return next;
}

export function applyHealthChange(state: RawHealthData, change: HealthDataChange): RawHealthData {
  switch (change.action) {
    case 'add':
      return { entries: upsert(state.entries, change.entity) };
    case 'patch':
      return {
        entries: state.entries.map((e) => (e.id === change.id ? { ...e, ...change.patch } : e)),
      };
    case 'bulkPatch': {
      if (change.ids.length === 0) return state;
      const targets = new Set(change.ids);
      return {
        entries: state.entries.map((e) => (targets.has(e.id) ? { ...e, ...change.patch } : e)),
      };
    }
    case 'delete':
      return { entries: state.entries.filter((e) => e.id !== change.id) };
    case 'reset':
      return { entries: [] };
  }
}

const rawHealthData = writable<RawHealthData>({ entries: [] });

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

  healthStoreReady = db.entries
    .toArray()
    .then((entries) => {
      let next: RawHealthData = { entries };
      for (const change of pendingChanges) next = applyHealthChange(next, change);
      pendingChanges.length = 0;
      loaded = true;
      rawHealthData.set(next);
    })
    .catch((err) => {
      console.error('Failed to load health data:', err);
    });
}

// Dose events (amountMg > 0, not skipped) carried forward with the last-known
// medication so older locally-saved doses still attribute to a drug.
function normalizeDoses(entries: HealthEntry[]) {
  let lastKnownMedication = '';
  return [...entries]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .filter((e) => e.amountMg != null && Number.isFinite(e.amountMg) && e.amountMg > 0 && e.skipped !== true)
    .map((e) => {
      const medication = e.medication || lastKnownMedication;
      if (e.medication) lastKnownMedication = e.medication;
      return { date: e.date, amountMg: e.amountMg as number, medication };
    })
    .filter((d) => d.medication);
}

// One row per entry (no merge-by-date). `mg in system` is a date-level quantity,
// so it's computed once per date and shown on each of that date's rows; weigh-in
// personalisation uses the per-date *average* weight.
function buildRows(entries: HealthEntry[]): HealthInputRow[] {
  const ordered = [...entries].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  const doseSnapshot = normalizeDoses(entries);
  const showMedicationLetters = new Set(doseSnapshot.map((d) => d.medication)).size > 1;

  const avgByDate = averageWeightLbsByDate(entries);
  const weighIns: WeighIn[] = [...avgByDate].map(([date, lbs]) => ({ date, weightKg: lbs * KG_PER_LB }));

  const systemByDate = new Map<string, HealthSystemAmount[]>();
  const systemForDate = (date: HealthEntry['date']) => {
    let s = systemByDate.get(date);
    if (!s) {
      s = enrichSystemAmounts(calculateSystemMgByDrug(doseSnapshot, date, weighIns));
      systemByDate.set(date, s);
    }
    return s;
  };

  return ordered.map((e): HealthInputRow => {
    const systemAmounts = e.skipped === true ? [] : systemForDate(e.date);
    return {
      entryId: e.id,
      day: '',
      date: e.date,
      system: e.skipped === true ? '' : formatSystemAmounts(systemAmounts, showMedicationLetters),
      systemAmounts,
      dose: e.amountMg != null ? String(e.amountMg) : '',
      dosePlanned: e.planned === true,
      doseConfirmedAt: e.confirmedAt,
      doseSkipped: e.skipped === true,
      medication: e.medication ?? '',
      prescriptionId: e.prescriptionId,
      weight: e.weightLbs != null ? String(e.weightLbs) : '',
      wellness: e.wellness != null ? String(e.wellness) : '',
      loss: '',
      symptoms: e.symptoms ?? [],
      shotLocation: e.site ?? '',
      notes: e.notes ?? '',
    };
  });
}

export const healthEntries = derived(rawHealthData, ($d) => buildRows($d.entries));

// Latest/earliest body weight = the per-date average of the latest/earliest
// dated day that has any weigh-in (so multiple weigh-ins on a day are smoothed).
function pickEdgeWeight(entries: HealthEntry[], edge: 'latest' | 'earliest'): number | null {
  const avgByDate = averageWeightLbsByDate(entries);
  let best: { date: string; lbs: number } | null = null;
  for (const [date, lbs] of avgByDate) {
    if (
      !best ||
      (edge === 'latest' ? date > best.date : date < best.date)
    ) {
      best = { date, lbs };
    }
  }
  return best?.lbs ?? null;
}

export const latestWeightLbs = derived(rawHealthData, ($d) => pickEdgeWeight($d.entries, 'latest'));
export const earliestWeightLbs = derived(rawHealthData, ($d) => pickEdgeWeight($d.entries, 'earliest'));

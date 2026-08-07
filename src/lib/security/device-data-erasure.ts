import Dexie, { type Table } from 'dexie';
import { writable } from 'svelte/store';
import { db } from '$lib/db/schema';
import { durableClose, durableDeleteOrThrow, durableOpen } from '$lib/db/durableKv';

const PENDING_ID = 'pending';
const COMPLETED_ID = 'last-completed';
const CHANNEL_NAME = 'evolvtrack-device-data-erasure';
const EMERGENCY_MARKER_KEY = 'evolvtrack-erasure-marker-unavailable';
const COORDINATION_DISCOVERY_MS = 40;
const COORDINATION_TIMEOUT_MS = import.meta.env.VITEST ? 150 : 2_000;

export type DeviceDataErasurePhase = 'erase' | 'account-deletion-prepared';

type ErasureMarker = {
  id: typeof PENDING_ID;
  operationId: string;
  phase: DeviceDataErasurePhase;
  committedAt: string;
};

type CompletionRecord = {
  id: typeof COMPLETED_ID;
  operationId: string;
  committedAt: string;
};

type ErasureRecord = ErasureMarker | CompletionRecord;

type CoordinationMessage =
  | { type: 'probe'; operationId: string }
  | { type: 'present'; operationId: string; tabId: string }
  | { type: 'account-deletion-prepared'; operationId: string }
  | { type: 'account-deletion-cancelled'; operationId: string }
  | { type: 'start'; operationId: string }
  | { type: 'ready'; operationId: string; tabId: string }
  | { type: 'complete'; operationId: string };

export type DeviceDataErasureState =
  | { status: 'idle' }
  | { status: 'erasing' }
  | { status: 'blocked'; message: string }
  | { status: 'complete' };

class DeviceDataErasureDb extends Dexie {
  records!: Table<ErasureRecord, ErasureRecord['id']>;

  constructor() {
    super('evolvtrack-erasure');
    this.version(1).stores({ markers: 'id' });
    this.version(2)
      .stores({ markers: 'id', records: 'id' })
      .upgrade(async (transaction) => {
        const oldMarker = await transaction.table<ErasureMarker>('markers').get(PENDING_ID);
        if (oldMarker) {
          await transaction.table<ErasureRecord>('records').put({
            ...oldMarker,
            operationId: oldMarker.operationId ?? operationId(),
            phase: oldMarker.phase ?? 'erase',
          });
          await transaction.table('markers').clear();
        }
      });
  }
}

const erasureDb = new DeviceDataErasureDb();
const state = writable<DeviceDataErasureState>({ status: 'idle' });
const tabId = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random()}`;
const tabOpenedAt = Date.now();
const discoveredTabs = new Set<string>();
const readyTabs = new Map<string, Set<string>>();
const readyWaiters = new Set<() => void>();
const handledOperations = new Set<string>();
let channel: BroadcastChannel | null = null;
let checkingCompletion = false;
let markerWriteFailureForTest: Error | null = null;
let discoveryOperationId: string | null = null;

export const deviceDataErasureState = { subscribe: state.subscribe };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Device Data Erasure could not complete.';
}

function operationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function revokeRuntimeState(): Promise<void> {
  const [{ stopSyncOrchestrator }, { deviceEncryptionState }, { revokeAuthStateForDeviceDataErasure }] =
    await Promise.all([
      import('$lib/sync/sync-orchestrator'),
      import('$lib/sync/device-encryption-state'),
      import('$lib/stores/authStore'),
    ]);
  const syncStopped = stopSyncOrchestrator();
  const encryptionRevoked = deviceEncryptionState.revokeForDeviceDataErasure();
  revokeAuthStateForDeviceDataErasure();

  const { revokeLocalAuthSessionForDeviceDataErasure } = await import('$lib/auth/supabase');
  await Promise.all([
    syncStopped,
    encryptionRevoked,
    revokeLocalAuthSessionForDeviceDataErasure(),
  ]);
}

function closeAppDatabases(): void {
  db.close();
  durableClose();
}

async function handleOtherTabStart(id: string): Promise<void> {
  if (handledOperations.has(id)) {
    ensureChannel()?.postMessage({ type: 'ready', operationId: id, tabId } satisfies CoordinationMessage);
    return;
  }
  state.set({ status: 'erasing' });
  try {
    await revokeRuntimeState();
  } finally {
    closeAppDatabases();
  }
  handledOperations.add(id);
  ensureChannel()?.postMessage({ type: 'ready', operationId: id, tabId } satisfies CoordinationMessage);
}

async function revokeIfCompletionWasMissed(): Promise<void> {
  if (checkingCompletion) return;
  checkingCompletion = true;
  try {
    const pending = await erasureDb.records.get(PENDING_ID);
    if (pending?.id === PENDING_ID) {
      if (pending.phase === 'account-deletion-prepared') {
        state.set({ status: 'erasing' });
        if (typeof window !== 'undefined' && !import.meta.env.VITEST) window.location.reload();
        return;
      }
      await handleOtherTabStart(pending.operationId);
      return;
    }

    const completion = await erasureDb.records.get(COMPLETED_ID);
    if (completion?.id !== COMPLETED_ID || handledOperations.has(completion.operationId)) return;
    if (Date.parse(completion.committedAt) <= tabOpenedAt) return;
    await handleOtherTabStart(completion.operationId);
  } finally {
    checkingCompletion = false;
  }
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  channel.addEventListener('message', (event: MessageEvent<CoordinationMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'probe') {
      channel?.postMessage({ type: 'present', operationId: message.operationId, tabId } satisfies CoordinationMessage);
    } else if (message.type === 'present' && message.operationId === discoveryOperationId) {
      discoveredTabs.add(message.tabId);
    } else if (message.type === 'account-deletion-prepared') {
      state.set({ status: 'erasing' });
      if (typeof window !== 'undefined' && !import.meta.env.VITEST) window.location.reload();
    } else if (message.type === 'account-deletion-cancelled') {
      state.set({ status: 'idle' });
      if (typeof window !== 'undefined' && !import.meta.env.VITEST) window.location.reload();
    } else if (message.type === 'start') {
      void handleOtherTabStart(message.operationId).catch(() => undefined);
    } else if (message.type === 'ready') {
      const ready = readyTabs.get(message.operationId) ?? new Set<string>();
      ready.add(message.tabId);
      readyTabs.set(message.operationId, ready);
      for (const wake of readyWaiters) wake();
    } else if (message.type === 'complete') {
      state.set({ status: 'complete' });
      if (typeof window !== 'undefined' && !import.meta.env.VITEST) window.location.reload();
    }
  });
  return channel;
}

async function coordinateOtherTabs(id: string): Promise<void> {
  const activeChannel = ensureChannel();
  if (!activeChannel && typeof window !== 'undefined') {
    throw new Error('This browser cannot verify that other EvolvTrack tabs released their data.');
  }

  discoveredTabs.clear();
  discoveryOperationId = id;
  readyTabs.set(id, new Set());
  activeChannel?.postMessage({ type: 'probe', operationId: id } satisfies CoordinationMessage);
  await delay(COORDINATION_DISCOVERY_MS);
  const expected = new Set(discoveredTabs);
  discoveryOperationId = null;
  activeChannel?.postMessage({ type: 'start', operationId: id } satisfies CoordinationMessage);

  const deadline = Date.now() + COORDINATION_TIMEOUT_MS;
  while ([...expected].some((expectedTab) => !readyTabs.get(id)?.has(expectedTab))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Another EvolvTrack tab did not release its readable data. Close other tabs and retry.');
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        const wake = () => {
          readyWaiters.delete(wake);
          resolve();
        };
        readyWaiters.add(wake);
      }),
      delay(remaining),
    ]);
  }
  readyTabs.delete(id);
}

async function writeMarker(phase: DeviceDataErasurePhase, id = operationId()): Promise<string> {
  try {
    if (markerWriteFailureForTest) {
      const failure = markerWriteFailureForTest;
      markerWriteFailureForTest = null;
      throw failure;
    }
    await erasureDb.records.put({ id: PENDING_ID, operationId: id, phase, committedAt: new Date().toISOString() });
    return id;
  } catch (cause) {
    try {
      localStorage.setItem(EMERGENCY_MARKER_KEY, '1');
    } catch {
      // The current runtime still fails closed through the erasure state.
    }
    state.set({ status: 'blocked', message: messageOf(cause) });
    throw cause;
  }
}

async function completeMarker(marker: ErasureMarker): Promise<void> {
  await erasureDb.transaction('rw', erasureDb.records, async () => {
    await erasureDb.records.put({
      id: COMPLETED_ID,
      operationId: marker.operationId,
      committedAt: new Date().toISOString(),
    });
    await erasureDb.records.delete(PENDING_ID);
  });
}

export async function getPendingDeviceDataErasure(): Promise<ErasureMarker | null> {
  const marker = await erasureDb.records.get(PENDING_ID);
  return marker?.id === PENDING_ID ? marker : null;
}

export async function isDeviceDataErasurePending(): Promise<boolean> {
  return (await getPendingDeviceDataErasure()) !== null;
}

function clearWebStorage(): void {
  localStorage.clear();
  sessionStorage.clear();
  if (localStorage.length !== 0 || sessionStorage.length !== 0) {
    throw new Error('Browser storage could not be verified empty.');
  }
}

async function deleteAppDatabases(): Promise<void> {
  closeAppDatabases();
  await durableDeleteOrThrow();
  await db.delete();
}

async function verifyAppDatabasesDeleted(): Promise<void> {
  if (await Dexie.exists('evolvtrack-auth')) {
    throw new Error('Authentication storage could not be verified removed.');
  }
  if (await Dexie.exists(db.name)) {
    throw new Error('Health data storage could not be verified removed.');
  }
}

async function reopenEmptyDatabases(): Promise<void> {
  await Promise.all([durableOpen(), db.open()]);
}

async function executePendingErasure(marker: ErasureMarker): Promise<'complete'> {
  if (marker.phase !== 'erase') throw new Error('Account deletion must be confirmed before local erasure.');
  state.set({ status: 'erasing' });
  handledOperations.add(marker.operationId);

  try {
    await Promise.all([
      coordinateOtherTabs(marker.operationId),
      revokeRuntimeState().finally(closeAppDatabases),
    ]);
    clearWebStorage();
    await deleteAppDatabases();
    await verifyAppDatabasesDeleted();
    await completeMarker(marker);
  } catch (cause) {
    state.set({ status: 'blocked', message: messageOf(cause) });
    throw cause;
  }

  await reopenEmptyDatabases().catch(() => undefined);
  state.set({ status: 'complete' });
  try {
    ensureChannel()?.postMessage({ type: 'complete', operationId: marker.operationId } satisfies CoordinationMessage);
  } catch {
    // Tabs also verify the retained completion record when they resume.
  }
  return 'complete';
}

/** Commit and execute a new non-cancellable Device Data Erasure. */
export async function beginDeviceDataErasure(afterMarked?: () => Promise<void>): Promise<void> {
  const id = await writeMarker('erase');
  state.set({ status: 'erasing' });
  await afterMarked?.();
  const marker = await getPendingDeviceDataErasure();
  if (!marker || marker.operationId !== id) throw new Error('Device Data Erasure marker changed unexpectedly.');
  await executePendingErasure(marker);
}

/** Write the durable half of the account-deletion handoff before the server request. */
export async function prepareAccountDeletionErasure(): Promise<string> {
  const id = await writeMarker('account-deletion-prepared');
  state.set({ status: 'erasing' });
  ensureChannel()?.postMessage({
    type: 'account-deletion-prepared',
    operationId: id,
  } satisfies CoordinationMessage);
  return id;
}

/** Promote a prepared handoff only after its server receipt is confirmed. */
export async function confirmAccountDeletionErasure(id: string): Promise<void> {
  const marker = await getPendingDeviceDataErasure();
  if (!marker || marker.operationId !== id || marker.phase !== 'account-deletion-prepared') {
    throw new Error('Account deletion handoff could not be verified.');
  }
  await erasureDb.records.put({ ...marker, phase: 'erase' });
  await executePendingErasure({ ...marker, phase: 'erase' });
}

/** Remove a prepared handoff after the server definitively rejects deletion. */
export async function cancelPreparedAccountDeletionErasure(id: string): Promise<void> {
  const marker = await getPendingDeviceDataErasure();
  if (marker?.operationId === id && marker.phase === 'account-deletion-prepared') {
    await erasureDb.records.delete(PENDING_ID);
    state.set({ status: 'idle' });
    ensureChannel()?.postMessage({
      type: 'account-deletion-cancelled',
      operationId: id,
    } satisfies CoordinationMessage);
  }
}

/** Resume erasure before normal app startup. Prepared account deletion remains blocked. */
export async function resumePendingDeviceDataErasure(): Promise<'none' | 'complete'> {
  const marker = await getPendingDeviceDataErasure();
  if (!marker) {
    let markerUnavailable = false;
    try {
      markerUnavailable = localStorage.getItem(EMERGENCY_MARKER_KEY) === '1';
    } catch {
      // No durable evidence means there is nothing safe to resume automatically.
    }
    if (!markerUnavailable) return 'none';
    await beginDeviceDataErasure();
    return 'complete';
  }
  return executePendingErasure(marker);
}

export async function retryDeviceDataErasure(): Promise<void> {
  const marker = await getPendingDeviceDataErasure();
  if (marker) await executePendingErasure(marker);
  else await beginDeviceDataErasure();
}

/** Test seam for resetting the dedicated marker and singleton stores. */
export async function __resetDeviceDataErasureForTests(): Promise<void> {
  channel?.close();
  channel = null;
  discoveredTabs.clear();
  readyTabs.clear();
  readyWaiters.clear();
  handledOperations.clear();
  discoveryOperationId = null;
  markerWriteFailureForTest = null;
  if (!erasureDb.isOpen()) await erasureDb.open();
  await erasureDb.records.clear();
  try {
    localStorage.removeItem(EMERGENCY_MARKER_KEY);
  } catch {
    // Test environment storage may be unavailable.
  }
  await reopenEmptyDatabases();
  state.set({ status: 'idle' });
  ensureChannel();
}

export function __failNextErasureMarkerWriteForTests(message: string): void {
  markerWriteFailureForTest = new Error(message);
}

if (typeof window !== 'undefined') {
  ensureChannel();
  window.addEventListener('focus', () => void revokeIfCompletionWasMissed());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void revokeIfCompletionWasMissed();
  });
}

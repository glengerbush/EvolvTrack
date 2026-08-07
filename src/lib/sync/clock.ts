/**
 * Server-anchored, monotonic wall clock for LWW timestamps.
 *
 * Conflict resolution (`merge.ts`, the delete/whole-row LWW in Health Data Storage) compares
 * `updatedAt` / `fieldUpdatedAt` stamps across devices. Those were stamped with
 * each device's *local* `Date.now()`, so a device whose clock runs fast wins every
 * conflict and a slow device's edits can be silently dropped — the classic
 * multi-device LWW hazard.
 *
 * This module removes most of that skew by stamping against the server's clock
 * instead: the sync loop samples server time (`recordServerTime`) and we keep the
 * offset (server − local). `now()` then returns `Date.now() + offset`, monotonic
 * so a backward jump (manual clock change, NTP step, DST glitch) can never make a
 * newer edit look older on the same device.
 *
 * The offset is persisted so a brand-new session (or an offline start) keeps the
 * last known correction until the next server sample refines it. With offset 0
 * and a forward-moving clock, `now()` is byte-identical to
 * `new Date().toISOString()` — so nothing changes until a server sample exists.
 */

const OFFSET_KEY = 'evolvtrack-clock-offset-ms';

// Clamp the persisted offset so a single bogus sample (e.g. a proxy returning a
// wildly wrong Date header) can't push every future timestamp years away.
const MAX_OFFSET_MS = 24 * 60 * 60 * 1000; // 24h

// How far backward the clock may step before we stop holding the high-water mark
// and just accept the new time. Small NTP/jitter steps are absorbed (no
// regression); a large step (timezone/date change, or a high-water mark left by
// a brief clock excursion into the future) resets instead of pinning every
// future timestamp to that stale peak.
const MAX_MONOTONIC_HOLD_MS = 5000; // 5s

let offsetMs = loadOffset();
// High-water mark of the last stamp we issued (ms). Bounds local regressions.
let lastIssuedMs = 0;

function loadOffset(): number {
  if (typeof localStorage === 'undefined') return 0;
  const raw = localStorage.getItem(OFFSET_KEY);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? clampOffset(n) : 0;
}

function clampOffset(ms: number): number {
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, ms));
}

/** Current epoch-ms stamp: local clock + server offset, with a bounded guard
 *  against small backward steps. */
function stampMs(): number {
  const corrected = Date.now() + offsetMs;
  if (corrected >= lastIssuedMs) {
    // Forward (or same millisecond) — track real time. Equal stamps on a
    // same-ms burst match the old `Date.now()` behavior.
    lastIssuedMs = corrected;
  } else if (lastIssuedMs - corrected > MAX_MONOTONIC_HOLD_MS) {
    // Big backward jump — accept it rather than freezing on a stale peak.
    lastIssuedMs = corrected;
  }
  // Otherwise: a small backward step; hold lastIssuedMs so we don't regress.
  return lastIssuedMs;
}

/** ISO timestamp for a new write. Drop-in replacement for `new Date().toISOString()`. */
export function now(): string {
  return new Date(stampMs()).toISOString();
}

/**
 * Fold a fresh server-time sample into the offset. `serverEpochMs` is the
 * server's notion of "now" (e.g. parsed from an HTTP `Date` header) at roughly
 * the moment of the call. Best-effort: callers pass whatever they could measure
 * and ignore failures.
 */
export function recordServerTime(serverEpochMs: number): void {
  if (!Number.isFinite(serverEpochMs)) return;
  offsetMs = clampOffset(serverEpochMs - Date.now());
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(OFFSET_KEY, String(offsetMs));
    } catch {
      /* storage full / disabled — keep the in-memory offset */
    }
  }
}

/** Server−local offset in ms (signed). Exposed for diagnostics / skew warnings. */
export function getClockOffsetMs(): number {
  return offsetMs;
}

/** Reset in-memory state. Test seam. */
export function __resetClockForTests(): void {
  offsetMs = 0;
  lastIssuedMs = 0;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetClockForTests,
  getClockOffsetMs,
  now,
  recordServerTime,
} from './clock';

beforeEach(() => {
  localStorage.clear();
  __resetClockForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clock.now', () => {
  it('returns an ISO-8601 timestamp', () => {
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('equals the local clock when there is no offset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'));
    expect(now()).toBe('2026-06-16T12:00:00.000Z');
  });

  it('absorbs a small backward wall-clock step (no regression)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'));
    const first = now();
    // Small NTP/jitter correction backward (2s, within the hold window).
    vi.setSystemTime(new Date('2026-06-16T11:59:58.000Z'));
    const second = now();
    expect(second).toBe(first); // held at the high-water mark, not regressed
  });

  it('resets on a large backward jump instead of freezing on a stale peak', () => {
    vi.useFakeTimers();
    // A brief excursion far into the future sets a high peak...
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    now();
    // ...then the clock is corrected back to the real present. We must accept it,
    // not pin every future timestamp to 2030.
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'));
    expect(now()).toBe('2026-06-16T12:00:00.000Z');
  });
});

describe('clock.recordServerTime', () => {
  it('shifts now() toward the server clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'));
    // Server is 10 minutes ahead of this device.
    recordServerTime(new Date('2026-06-16T12:10:00.000Z').getTime());
    expect(getClockOffsetMs()).toBe(10 * 60 * 1000);
    expect(now()).toBe('2026-06-16T12:10:00.000Z');
  });

  it('clamps an absurd sample to ±24h so one bad header cannot run away', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'));
    recordServerTime(new Date('2030-01-01T00:00:00.000Z').getTime());
    expect(getClockOffsetMs()).toBe(24 * 60 * 60 * 1000);
  });

  it('persists the offset so a later session starts corrected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'));
    recordServerTime(new Date('2026-06-16T12:05:00.000Z').getTime());
    expect(localStorage.getItem('evolvtrack-clock-offset-ms')).toBe(String(5 * 60 * 1000));
  });

  it('ignores a non-finite sample', () => {
    recordServerTime(Number.NaN);
    expect(getClockOffsetMs()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPullCursor, getPullCursor, setPullCursor } from './pull-cursor';

beforeEach(() => clearPullCursor());
afterEach(() => clearPullCursor());

describe('pull cursor', () => {
  it('starts null when nothing has been pulled', () => {
    expect(getPullCursor()).toBeNull();
  });

  it('round-trips a stored cursor value', () => {
    setPullCursor('2026-05-10T00:00:00.000Z');
    expect(getPullCursor()).toBe('2026-05-10T00:00:00.000Z');
  });

  it('clears back to null', () => {
    setPullCursor('2026-05-10T00:00:00.000Z');
    clearPullCursor();
    expect(getPullCursor()).toBeNull();
  });

  it('advances to the most recently set value', () => {
    setPullCursor('2026-05-10T00:00:00.000Z');
    setPullCursor('2026-05-11T00:00:00.000Z');
    expect(getPullCursor()).toBe('2026-05-11T00:00:00.000Z');
  });
});

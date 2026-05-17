import { describe, expect, it } from 'vitest';
import { SYNC_PROTOCOL_VERSION } from './protocol';

describe('SYNC_PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(SYNC_PROTOCOL_VERSION)).toBe(true);
    expect(SYNC_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('is currently 1 — bumping this is a wire-format change and must be deliberate', () => {
    // This assertion is intentionally tight. If you bump SYNC_PROTOCOL_VERSION,
    // update this test in the same commit and explain the wire-format change
    // in the message.
    expect(SYNC_PROTOCOL_VERSION).toBe(1);
  });
});

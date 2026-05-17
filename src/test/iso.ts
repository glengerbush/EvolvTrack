import type { IsoDate } from '$lib/domain/types';
import { asIsoDate } from '$lib/utils/dateKeys';

/**
 * Test-only: brand a literal `YYYY-MM-DD` string as `IsoDate`. Throws if the
 * literal is malformed, which beats accidentally passing `"2025-13-99"` into
 * a test fixture.
 */
export function iso(literal: string): IsoDate {
  const parsed = asIsoDate(literal);
  if (!parsed) throw new Error(`Invalid ISO date in test fixture: ${literal}`);
  return parsed;
}

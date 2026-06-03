/**
 * A human-readable message for any thrown value.
 *
 * Supabase / Postgrest errors are plain objects (not `Error` instances), so
 * `String(error)` on them produces the useless "[object Object]". This pulls a
 * real message out of whatever was thrown: an `Error`, a string, a Postgrest-
 * style `{ message, details, hint, code }`, or — as a last resort — JSON.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown };
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.details === 'string' && e.details) return e.details;
    if (typeof e.hint === 'string' && e.hint) return e.hint;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Incremental-pull cursor: the server-set `inserted_at` of the most recent
 * remote event already applied locally. The next pull asks only for rows
 * inserted after this point.
 *
 * `inserted_at` (cloud time) is used rather than `created_at` (device edit
 * time) because it is monotonic and consistent across devices — a device with
 * a skewed clock can't slip an event past the cursor. Stored in localStorage
 * so it survives reloads; `logout` clears localStorage and resets it.
 */
const CURSOR_KEY = 'evolvtrack-pull-cursor';

export function getPullCursor(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(CURSOR_KEY);
}

export function setPullCursor(cursor: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CURSOR_KEY, cursor);
}

export function clearPullCursor(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(CURSOR_KEY);
}

/**
 * Pure column-ordering helpers shared by every editable grid (the inputs table,
 * the medication dosage/vial tables). Extracted verbatim from the logic that
 * lived inline in `InputsTable.svelte` so it can be unit-tested once and reused.
 */

/** Move one item within an array, returning a new array (out-of-range = no-op). */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = [...arr];
  if (from === to) return next;
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Reorder a key list where only the *visible* (non-hidden) keys are addressed by
 * the `from`/`to` indices, preserving the positions of hidden keys. Mirrors the
 * old `reorderColumns` in InputsTable.
 */
export function reorderVisible<K>(
  order: readonly K[],
  isHidden: (key: K) => boolean,
  from: number,
  to: number,
): K[] {
  if (from === to) return [...order];
  const visibleKeys = order.filter((key) => !isHidden(key));
  if (!visibleKeys[from] || !visibleKeys[to]) return [...order];

  const [moved] = visibleKeys.splice(from, 1);
  visibleKeys.splice(to, 0, moved);

  let visibleIndex = 0;
  return order.map((key) => (isHidden(key) ? key : visibleKeys[visibleIndex++]));
}

/**
 * The drop indicator for a column drag: which column edge to mark. `null` when
 * there's no active drag or the drag wouldn't move anything.
 */
export function colIndicator(
  dragIndex: number | null,
  dragoverIndex: number | null,
  colCount: number,
): { col: number; side: 'left' | 'right' } | null {
  if (dragIndex === null || dragoverIndex === null) return null;
  if (dragIndex === dragoverIndex) return null;
  if (dragIndex > dragoverIndex) return { col: dragoverIndex, side: 'left' };
  const next = dragoverIndex + 1;
  return next < colCount ? { col: next, side: 'left' } : { col: dragoverIndex, side: 'right' };
}

/**
 * Reconcile a persisted column order against the current default order: keep the
 * saved order for known keys, and splice any new default keys in next to their
 * default-order neighbour (so a newly-added column lands in a sensible spot for
 * users with old saved settings). Mirrors the old `mergeColumnOrder`.
 */
export function mergeColumnOrder<K extends string>(
  savedOrder: readonly string[] | undefined,
  defaultOrder: readonly K[],
): K[] {
  const validKeys = new Set<K>(defaultOrder);
  const merged = (savedOrder ?? []).filter((key): key is K => validKeys.has(key as K));

  for (const key of defaultOrder) {
    if (merged.includes(key)) continue;
    const defaultIndex = defaultOrder.indexOf(key);
    const previousKey = [...defaultOrder.slice(0, defaultIndex)]
      .reverse()
      .find((candidate) => merged.includes(candidate));
    if (previousKey) merged.splice(merged.indexOf(previousKey) + 1, 0, key);
    else merged.unshift(key);
  }

  return merged;
}

/** Filter a persisted hidden-column list down to currently-valid keys. */
export function sanitizeHidden<K extends string>(
  savedHidden: readonly string[] | undefined,
  defaultOrder: readonly K[],
): K[] {
  const validKeys = new Set<K>(defaultOrder);
  return (savedHidden ?? []).filter((key): key is K => validKeys.has(key as K));
}

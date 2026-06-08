/**
 * Pure virtualization math (prefix-sum offsets + visible-range computation),
 * extracted from `InputsTable.svelte`. The DOM measurement, scroll listeners and
 * anchor compensation stay in the controller (`gridVirtualizer.svelte.ts`); this
 * is the part that can be unit-tested in isolation.
 */

/** Cumulative row-top offsets: `prefix[i]` = summed height of rows `[0, i)`. */
export function buildPrefix(heights: readonly number[]): number[] {
  const n = heights.length;
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + heights[i];
  return prefix;
}

/** Largest index `i` in `[0, count]` with `prefix[i] <= target` (binary search). */
export function indexAtOffset(prefix: readonly number[], target: number, count: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type VisibleRange = {
  first: number;
  last: number;
  topSpacer: number;
  bottomSpacer: number;
};

/**
 * Given the prefix table and the current scroll geometry, compute which rows to
 * render (with `overscan` padding) and the spacer heights above/below them.
 *
 * - `scrolledPast`  = how far row 0's top is above the viewport top (`max(0, -tbodyTop)`).
 * - `bottomFromTop` = viewport bottom relative to row 0's top (`max(0, innerHeight - tbodyTop)`).
 */
export function computeVisibleRange(
  prefix: readonly number[],
  rowCount: number,
  scrolledPast: number,
  bottomFromTop: number,
  overscan: number,
): VisibleRange {
  if (rowCount === 0) return { first: 0, last: 0, topSpacer: 0, bottomSpacer: 0 };

  let first = indexAtOffset(prefix, scrolledPast, rowCount) - overscan;
  if (first < 0) first = 0;
  let last = indexAtOffset(prefix, bottomFromTop, rowCount) + overscan;
  if (last > rowCount - 1) last = rowCount - 1;
  if (last < first) last = first;

  return {
    first,
    last,
    topSpacer: prefix[first],
    bottomSpacer: Math.max(0, prefix[rowCount] - prefix[last + 1]),
  };
}

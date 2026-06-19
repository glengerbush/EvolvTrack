import { daysBetween, parseDateKey } from '$lib/utils/dateKeys';
import type { IsoDate } from '$lib/domain/types';

/**
 * Per-row info for the inputs table's left-most "week" rail. The rail is a
 * fixed gutter column (not part of the reorderable/hideable set) showing a
 * week number, with consecutive same-week rows visually merged into one block.
 */
export interface WeekCell {
  /** Week number (1-based), or `null` when the row has no valid date. */
  week: number | null;
  /** The block's vertically-centred row — the only one that paints "W#" on
   *  desktop (others in the block are blank so the block reads as one cell). */
  isLabelRow: boolean;
  /** First / last row of a contiguous same-week block, in display order — used
   *  to draw the block's top/bottom divider while suppressing interior ones. */
  isFirstOfWeek: boolean;
  isLastOfWeek: boolean;
}

/**
 * Week number for `dateKey`, counting from `anchorKey` (the earliest logged
 * day) in rolling 7-day blocks: the anchor's own day is Week 1.
 */
export function weekNumberFor(dateKey: string, anchorKey: IsoDate): number | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  return Math.floor(daysBetween(anchorKey, dateKey as IsoDate) / 7) + 1;
}

/**
 * Compute the week rail for rows given in display order. The anchor is the
 * earliest valid date across all rows (independent of display order or which
 * rows are currently virtualized), so numbering is stable while scrolling.
 *
 * Rows with no valid date get `week: null` and break a block (each stands
 * alone). Same-week rows are assumed contiguous, which holds when rows are
 * date-sorted — same calendar week can't be interrupted by another week.
 */
export function computeWeekCells(dateKeys: readonly string[]): WeekCell[] {
  let anchor: IsoDate | null = null;
  for (const key of dateKeys) {
    if (!parseDateKey(key)) continue;
    if (anchor === null || key < anchor) anchor = key as IsoDate;
  }

  const weeks = dateKeys.map((key) => (anchor ? weekNumberFor(key, anchor) : null));
  const cells: WeekCell[] = weeks.map((week) => ({
    week,
    isLabelRow: false,
    isFirstOfWeek: false,
    isLastOfWeek: false,
  }));

  let i = 0;
  while (i < weeks.length) {
    const week = weeks[i];
    if (week === null) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < weeks.length && weeks[j + 1] === week) j += 1;
    cells[i].isFirstOfWeek = true;
    cells[j].isLastOfWeek = true;
    // Centre the label: middle row of the block (biased to the top half for
    // even-sized blocks), so the number sits visually centred in the merge.
    cells[i + Math.floor((j - i) / 2)].isLabelRow = true;
    i = j + 1;
  }

  return cells;
}

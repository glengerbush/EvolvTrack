/**
 * Pure cell-navigation math for the spreadsheet grids. The stateful controller
 * (`gridSelection.svelte.ts`) and the DOM live elsewhere; this is just the
 * arithmetic of "where does the selection go", so it can be unit-tested.
 */

export type Sel = { row: number; col: number };
export type GridDims = { rowCount: number; colCount: number };

/** Clamp a row index into `[0, rowCount-1]` (or 0 when empty). */
export function clampRow(row: number, rowCount: number): number {
  return Math.min(Math.max(row, 0), Math.max(0, rowCount - 1));
}

/** Clamp a column index into `[0, colCount-1]` (or 0 when empty). */
export function clampCol(col: number, colCount: number): number {
  return Math.min(Math.max(col, 0), Math.max(0, colCount - 1));
}

/**
 * The plain grid move: shift the selection by `(dr, dc)` and clamp to the grid.
 * Bespoke sub-stops (e.g. the inputs table's vial/due badges) are layered on top
 * by the controller's consumer — they are intentionally NOT modelled here.
 */
export function clampMove(sel: Sel, dr: number, dc: number, dims: GridDims): Sel {
  return {
    row: clampRow(sel.row + dr, dims.rowCount),
    col: clampCol(sel.col + dc, dims.colCount),
  };
}

/**
 * Step from `start` in direction `dir` (+1 / -1) to the next index that
 * `isSelectable`, skipping the rest. Used when some rows/cols aren't navigable
 * (e.g. the progress card's computed rows). Clamps by staying put if none.
 */
export function nextSelectable(
  start: number,
  dir: 1 | -1,
  count: number,
  isSelectable: (i: number) => boolean,
): number {
  for (let i = start + dir; i >= 0 && i < count; i += dir) {
    if (isSelectable(i)) return i;
  }
  return start;
}

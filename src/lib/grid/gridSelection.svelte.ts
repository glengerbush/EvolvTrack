import { tick } from 'svelte';
import { clampCol, clampRow, nextSelectable } from './gridNav';

/**
 * Reusable spreadsheet selection + keyboard state machine, extracted from the
 * inputs table so every editable grid (inputs, medication tables, progress card)
 * shares one implementation. The consumer renders its own markup and supplies
 * the table-specific bits via config; this class owns `selRow/selCol/editing`,
 * the keyboard handlers, and editor focus.
 *
 * Focus model (accessible roving-tabindex grid):
 *  - Exactly one cell is a tab stop (`tabIndexFor`): the active cell, or a
 *    designated default cell when nothing is active yet. So Tab / Shift+Tab move
 *    focus INTO and OUT of the grid like any other widget — they're never
 *    intercepted. Arrow keys move between cells.
 *  - The selection ring is driven by real DOM `:focus` in CSS, so it shows only
 *    while a grid cell is focused and there's never more than one on the page.
 *  - We focus the editor when editing starts, and focus the cell after explicit
 *    navigation/commit — but never steal focus back on blur (so tabbing away
 *    works).
 */
export type GridSelectionConfig = {
  rowCount: () => number;
  colCount: () => number;
  /** Can this cell be entered for editing (a text editor OR an inline picker)? */
  isEditable: (row: number, col: number) => boolean;
  /** Is this cell navigable at all? Defaults to true; lets a grid skip e.g.
   *  computed/read-only rows (the progress card). */
  isSelectable?: (row: number, col: number) => boolean;
  /** The cell `<td>` element — the consumer renders `data-cell="r-c"`. */
  cellRef: (row: number, col: number) => HTMLElement | null;
  /** Persist the row on commit (Enter/blur). May reorder + reposition the
   *  selection (it can set `sel.selRow`). */
  commit?: (row: number) => void | Promise<void>;
  /** Clear a cell (Delete/Backspace). */
  clear?: (row: number, col: number) => void;
  /** Seed the editor when edit begins (typed char, or null for click/Enter). */
  beginEditSeed?: (row: number, col: number, seed: string | null) => void;
  /** Restore the pre-edit value (Escape). */
  cancelEdit?: (row: number, col: number) => void;
  /** CSS selector for a sticky page header to keep cells clear of when scrolling
   *  up (e.g. the dashboard tab bar). */
  stickyTopSelector?: string;
  /** Intercept a move before the default grid nav (for bespoke sub-stops).
   *  Return true if the consumer handled it. */
  interceptMove?: (dr: number, dc: number) => boolean;
};

export class GridSelection {
  selRow = $state<number | null>(null);
  selCol = $state<number | null>(null);
  editing = $state(false);
  #cfg: GridSelectionConfig;

  constructor(cfg: GridSelectionConfig) {
    this.#cfg = cfg;
    // Only move focus when EDITING starts — focus the inline editor. We never
    // auto-focus the cell here (that would steal focus back when the user tabs
    // away); cell focus is done explicitly by the navigation/commit methods.
    $effect(() => {
      if (!this.editing) return;
      const r = this.selRow;
      const c = this.selCol;
      if (r === null || c === null) return;
      void tick().then(() => {
        const cell = cfg.cellRef(r, c);
        const ctrl = cell?.querySelector<HTMLElement>('input, textarea');
        if (!ctrl) return; // picker cells manage their own focus
        ctrl.focus({ preventScroll: true });
        if (ctrl instanceof HTMLInputElement && ctrl.type !== 'date') {
          const len = ctrl.value.length;
          try {
            ctrl.setSelectionRange(len, len);
          } catch {
            /* number inputs reject selection range */
          }
        }
      });
    });
  }

  private isSelectable(r: number, c: number): boolean {
    return this.#cfg.isSelectable ? this.#cfg.isSelectable(r, c) : true;
  }

  isSelected(r: number, c: number): boolean {
    return this.selRow === r && this.selCol === c;
  }
  isCellEditing(r: number, c: number): boolean {
    return this.editing && this.selRow === r && this.selCol === c;
  }

  /** Roving tabindex: the active cell (or `isDefaultCell` when nothing's active
   *  yet) is the grid's single tab stop. */
  tabIndexFor(r: number, c: number, isDefaultCell = false): 0 | -1 {
    if (this.selRow === null && this.selCol === null) return isDefaultCell ? 0 : -1;
    return this.isSelected(r, c) ? 0 : -1;
  }

  private focusCell(): void {
    const r = this.selRow;
    const c = this.selCol;
    if (r === null || c === null) return;
    void tick().then(() => this.#cfg.cellRef(r, c)?.focus({ preventScroll: true }));
  }

  selectCell(r: number, c: number, startEdit = false): void {
    this.selRow = r;
    this.selCol = c;
    this.editing = startEdit && this.#cfg.isEditable(r, c);
  }

  beginEdit(seed: string | null = null): void {
    if (this.selRow === null || this.selCol === null) return;
    if (!this.#cfg.isEditable(this.selRow, this.selCol)) return;
    this.#cfg.beginEditSeed?.(this.selRow, this.selCol, seed);
    this.editing = true;
  }

  cancelEdit(): void {
    if (this.selRow !== null && this.selCol !== null) {
      this.#cfg.cancelEdit?.(this.selRow, this.selCol);
    }
    this.editing = false;
    this.focusCell();
  }

  /** Editor lost focus (tab/click away): commit + stop editing, but do NOT pull
   *  focus back — let it land where the user sent it. */
  stopEditing(): void {
    this.editing = false;
  }

  // Scroll just enough to reveal a cell, leaving room above for a sticky header.
  scrollCellIntoView(cell: HTMLElement): void {
    const bar = this.#cfg.stickyTopSelector
      ? document.querySelector(this.#cfg.stickyTopSelector)
      : null;
    const barRect = bar?.getBoundingClientRect();
    const safeTop = barRect && barRect.top <= 1 ? barRect.bottom : 0;
    const rect = cell.getBoundingClientRect();
    if (rect.top < safeTop) {
      window.scrollBy({ top: rect.top - safeTop, left: 0, behavior: 'auto' });
    } else if (rect.bottom > window.innerHeight) {
      window.scrollBy({ top: rect.bottom - window.innerHeight, left: 0, behavior: 'auto' });
    }
  }

  private scrollSelIntoView(): void {
    void tick().then(() => {
      if (this.selRow === null || this.selCol === null) return;
      const cell = this.#cfg.cellRef(this.selRow, this.selCol);
      if (cell) this.scrollCellIntoView(cell);
    });
  }

  moveSelection(dr: number, dc: number): void {
    if (this.selRow === null || this.selCol === null) {
      this.selectCell(0, 0);
      this.focusCell();
      this.scrollSelIntoView();
      return;
    }
    if (this.#cfg.interceptMove?.(dr, dc)) return;

    const rowCount = this.#cfg.rowCount();
    const colCount = this.#cfg.colCount();
    if (dr !== 0) {
      let r = clampRow(this.selRow + dr, rowCount);
      if (!this.isSelectable(r, this.selCol)) {
        r = nextSelectable(this.selRow, dr > 0 ? 1 : -1, rowCount, (i) =>
          this.isSelectable(i, this.selCol as number),
        );
      }
      this.selectCell(r, this.selCol);
    } else if (dc !== 0) {
      let c = clampCol(this.selCol + dc, colCount);
      if (!this.isSelectable(this.selRow, c)) {
        c = nextSelectable(this.selCol, dc > 0 ? 1 : -1, colCount, (i) =>
          this.isSelectable(this.selRow as number, i),
        );
      }
      this.selectCell(this.selRow, c);
    }
    this.focusCell();
    this.scrollSelIntoView();
  }

  async commitEdit(): Promise<void> {
    const r = this.selRow;
    this.editing = false;
    if (r !== null) await this.#cfg.commit?.(r);
    this.focusCell();
  }

  // Return focus from an inner control (editor/picker) to the cell so arrow-key
  // grid navigation resumes.
  exitToCell(r: number, c: number): void {
    this.editing = false;
    this.selRow = r;
    this.selCol = c;
    void tick().then(() => this.#cfg.cellRef(r, c)?.focus({ preventScroll: true }));
  }

  private isPrintable(e: KeyboardEvent): boolean {
    return e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey;
  }

  cellKeydown = (e: KeyboardEvent, r: number, c: number): void => {
    // Once focus is inside an inner control, that control owns the keys (except
    // Escape → back to the cell).
    if (e.target !== e.currentTarget) {
      if (e.key === 'Escape') this.exitToCell(r, c);
      return;
    }
    // Sync the active cell to whatever is focused (e.g. after tabbing in or
    // clicking) so arrow nav continues from here.
    this.selRow = r;
    this.selCol = c;
    switch (e.key) {
      // Tab / Shift+Tab are deliberately NOT handled — they fall through to the
      // browser so focus moves to the next/previous element on the page.
      case 'ArrowDown': e.preventDefault(); this.moveSelection(1, 0); return;
      case 'ArrowUp': e.preventDefault(); this.moveSelection(-1, 0); return;
      case 'ArrowLeft': e.preventDefault(); this.moveSelection(0, -1); return;
      case 'ArrowRight': e.preventDefault(); this.moveSelection(0, 1); return;
      case 'Enter':
      case 'F2': e.preventDefault(); this.beginEdit(); return;
      case 'Escape': return;
      case 'Delete':
      case 'Backspace':
        if (this.#cfg.isEditable(r, c)) {
          e.preventDefault();
          this.#cfg.clear?.(r, c);
        }
        return;
      default:
        if (this.isPrintable(e)) {
          e.preventDefault();
          this.beginEdit(e.key);
        }
    }
  };

  // Shared by text editors. Plain Enter commits in place; Shift+Enter is left to
  // the browser (newline in a textarea); Esc cancels. Tab is left to the browser
  // so focus moves out of the grid normally.
  editorKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      void this.commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancelEdit();
    }
  };
}

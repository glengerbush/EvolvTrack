<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import CustomPicker from '$lib/components/dashboard/tables/CustomPicker.svelte';
  import MultiPicker from '$lib/components/dashboard/tables/MultiPicker.svelte';
  import DateInput from '$lib/components/dashboard/tables/DateInput.svelte';
  import DoseVialPicker from '$lib/components/dashboard/tables/DoseVialPicker.svelte';
  import ConfirmDialog from '$lib/components/dashboard/tables/ConfirmDialog.svelte';
  import EditPencil from '$lib/components/dashboard/EditPencil.svelte';
  import SaveIcon from '$lib/components/icons/SaveIcon.svelte';
  import TrashIcon from '$lib/components/icons/TrashIcon.svelte';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { isMobile } from '$lib/stores/viewport';
  import type { HealthInputRow, HealthSystemAmount } from '$lib/stores/healthTypes';
  import { weightUnit, displayWeight, toStoredLbs } from '$lib/stores/unitStore';
  import { autoVialByEntryId, medicationRows, vialByEntryId } from '$lib/stores/medicationStore';
  import {
    addSymptomOption,
    removeSymptomOption,
    setSymptomColor,
    symptomColor as resolveSymptomColor,
    symptomColors,
    symptomOptions,
  } from '$lib/stores/symptomStore';
  import {
    addShotLocationOption,
    removeShotLocationOption,
    shotLocationOptions,
  } from '$lib/stores/shotLocationStore';
  import { columnDecimals, fmtNum, lbsToDisplayNum } from '$lib/utils/format';
  import {
    getInputTableSettings,
    saveInputRows,
    saveInputTableSettings,
    type HealthInputRowSaveInput,
    type SavedHealthInputRow,
  } from '$lib/domain/healthInputs';
  import {
    deleteEntry,
    getAllEntries,
    updateEntry,
  } from '$lib/domain/repo';
  import {
    WELLNESS_SCORE_MAX,
    WELLNESS_SCORE_MIN,
    normalizeWellnessScoreInput,
    parseWellnessScore,
  } from '$lib/domain/wellness';
  import { DRUG_PK, formatSystemMg } from '$lib/utils/pharmacokinetics';
  import { addDays, formatLocaleDate, localDateKey, maxDateKey } from '$lib/utils/dateKeys';
  import {
    calculateDay,
    cloneRow,
    parseWeight,
    recalculateDerived as recalculateDerivedPure,
    type RecalcScope,
  } from '$lib/utils/healthRowDerived';
  import type { HealthColKey, HealthEntry, IsoDate, Medication } from '$lib/domain/types';
  import {
    colIndicator as computeColIndicator,
    mergeColumnOrder as mergeColumnOrderShared,
    reorderVisible,
    sanitizeHidden,
  } from '$lib/grid/columnReorder';
  import {
    buildPrefix,
    computeVisibleRange,
    indexAtOffset as indexAtOffsetShared,
  } from '$lib/grid/virtualize';

  type ColumnKey = HealthColKey;
  type ManagedOptionKind = 'symptom' | 'shotLocation';

  type Column = {
    key: ColumnKey;
    label: string;
  };

  type EditableInputRow = HealthInputRow & {
    draftId?: string;
  };

  type PersistedHealthRecords = {
    entries: HealthEntry[];
  };

  type OptionDeleteRequest = {
    kind: ManagedOptionKind;
    option: string;
    count: number;
  };

  let {
    rows = [],
    isSettingsOpen = false,
    addRowSignal = 0,
  }: {
    rows?: HealthInputRow[];
    /** Gear toggle: opens the column/option managers and the trash-can gutter. */
    isSettingsOpen?: boolean;
    addRowSignal?: number;
  } = $props();

  const DEFAULT_COL_ORDER: ColumnKey[] = ['day', 'date', 'weight', 'wellness', 'symptoms', 'system', 'loss', 'dose', 'shotLocation', 'notes'];

  let columnOrder = $state<ColumnKey[]>([...DEFAULT_COL_ORDER]);
  let savedColumnOrder = $state<ColumnKey[]>([...DEFAULT_COL_ORDER]);
  const hiddenColumns = new SvelteSet<ColumnKey>();
  const savedHiddenColumns = new SvelteSet<ColumnKey>();

  const columnLabelsByKey = $derived.by<Record<ColumnKey, string>>(() => ({
    day: 'Day', date: 'Date', system: 'mg in system', dose: 'Dose (mg)', medication: 'Medication',
    weight: `Weight (${$weightUnit})`, wellness: 'Wellness',
    loss: `Loss (${$weightUnit})`, symptoms: 'Symptoms',
    shotLocation: 'Shot Location', notes: 'Notes',
  }));
  const columns = $derived.by<Column[]>(() => columnOrder.map((key) => ({ key, label: columnLabelsByKey[key] })));
  const savedColumns = $derived.by<Column[]>(() => savedColumnOrder.map((key) => ({ key, label: columnLabelsByKey[key] })));

  let colDragIndex = $state<number | null>(null);
  let colDragoverIndex = $state<number | null>(null);
  let colKbIndex = $state<number | null>(null);
  let announcement = $state('');
  // Single-mode: the gear opens settings (column reorder/hide + option managers)
  // and reveals the per-row trash-can gutter. No longer tied to an edit mode.
  const columnSettingsOpen = $derived(isSettingsOpen);

  const colIndicator = $derived.by(() =>
    computeColIndicator(colDragIndex, colDragoverIndex, activeColumns.length),
  );

  function reorderColumns(from: number, to: number) {
    if (!columnSettingsOpen) return;
    if (from === to) return;
    columnOrder = reorderVisible(columnOrder, (key) => hiddenColumns.has(key), from, to);
    persistColumnSettings();
  }

  async function announce(msg: string) {
    announcement = '';
    await tick();
    announcement = msg;
  }

  async function focusById(id: string) {
    await tick();
    (document.getElementById(id) as HTMLElement | null)?.focus();
  }

  function colKeydown(e: KeyboardEvent, index: number) {
    if (!columnSettingsOpen) return;
    const n = activeColumns.length;
    if (e.key === ' ') {
      e.preventDefault();
      if (colKbIndex === null) {
        colKbIndex = index;
        void announce(`Grabbed ${activeColumns[index].label} column. Use left and right arrow keys to move, Space to drop, Escape to stop.`);
      } else {
        void announce(`Dropped. ${activeColumns[colKbIndex].label} column is now at position ${colKbIndex + 1} of ${n}.`);
        colKbIndex = null;
      }
    } else if (e.key === 'Escape' && colKbIndex !== null) {
      e.preventDefault();
      const key = activeColumns[colKbIndex].key;
      colKbIndex = null;
      void announce('Stopped column reordering.');
      void focusById(`col-handle-${key}`);
    } else if (e.key === 'ArrowLeft' && colKbIndex !== null && colKbIndex > 0) {
      e.preventDefault();
      reorderColumns(colKbIndex, colKbIndex - 1);
      colKbIndex -= 1;
      void announce(`${activeColumns[colKbIndex].label} column, position ${colKbIndex + 1} of ${n}.`);
      void focusById(`col-handle-${activeColumns[colKbIndex].key}`);
    } else if (e.key === 'ArrowRight' && colKbIndex !== null && colKbIndex < n - 1) {
      e.preventDefault();
      reorderColumns(colKbIndex, colKbIndex + 1);
      colKbIndex += 1;
      void announce(`${activeColumns[colKbIndex].label} column, position ${colKbIndex + 1} of ${n}.`);
      void focusById(`col-handle-${activeColumns[colKbIndex].key}`);
    }
  }

  const medicationOptions = $derived.by(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    const addOption = (value: string | undefined) => {
      const normalized = value?.trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      options.push(normalized);
    };

    for (const row of $medicationRows) addOption(row.type);
    for (const row of rows) addOption(row.medication);
    for (const medication of Object.keys(DRUG_PK)) addOption(medication);

    return options;
  });

  const defaultMedication = $derived.by(() => {
    const currentVial = [...$medicationRows]
      .filter((row) => row.type && row.dosesLeft > 0)
      .sort((a, b) => a.id - b.id)[0];
    return currentVial?.type || medicationOptions[0] || '';
  });

  function resolveDoseMedication(row: Pick<HealthInputRow, 'medication'>): string {
    return row.medication || defaultMedication;
  }

  // A row with a real dose but no medication can't be modelled by the
  // pharmacokinetics engine, so it never appears on the "mg in system" graph.
  function rowMissingMedication(row: Pick<HealthInputRow, 'dose' | 'medication'>): boolean {
    const dose = parseFloat(row.dose);
    return Number.isFinite(dose) && dose > 0 && !row.medication;
  }

  function mergeColumnOrder(savedOrder: string[] | undefined): ColumnKey[] {
    return mergeColumnOrderShared(savedOrder, DEFAULT_COL_ORDER);
  }

  function applyHiddenColumnSettings(target: SvelteSet<ColumnKey>, savedHidden: string[] | undefined) {
    target.clear();
    for (const key of sanitizeHidden(savedHidden, DEFAULT_COL_ORDER)) target.add(key);
  }

  let colSettingsLoaded = $state(false);
  let localColumnSettingsChanged = false;
  let pendingColumnSettingsSave = Promise.resolve();
  let inputsTableRegion: HTMLDivElement | null = null;

  function syncSavedColumnSettings(order: ColumnKey[], hidden: ColumnKey[]) {
    savedColumnOrder = [...order];
    savedHiddenColumns.clear();
    for (const column of hidden) {
      savedHiddenColumns.add(column);
    }
  }

  function persistColumnSettings() {
    localColumnSettingsChanged = true;
    const nextColumnOrder = [...columnOrder];
    const nextHiddenColumns = [...hiddenColumns];
    syncSavedColumnSettings(nextColumnOrder, nextHiddenColumns);

    pendingColumnSettingsSave = pendingColumnSettingsSave
      .catch(() => undefined)
      .then(() =>
        saveInputTableSettings({
          columnOrder: nextColumnOrder,
          hiddenColumns: nextHiddenColumns,
        }),
      )
      .catch((err) => console.error('Failed to save column settings:', err));
  }

  $effect(() => {
    if (colSettingsLoaded) return;
    colSettingsLoaded = true;
    void getInputTableSettings().then((settings) => {
      const nextColumnOrder = mergeColumnOrder(settings.columnOrder);
      if (localColumnSettingsChanged) return;

      savedColumnOrder = [...nextColumnOrder];
      applyHiddenColumnSettings(savedHiddenColumns, settings.hiddenColumns);
      columnOrder = [...nextColumnOrder];
      applyHiddenColumnSettings(hiddenColumns, settings.hiddenColumns);
    });
  });

  function resetTable() {
    columnOrder = [...DEFAULT_COL_ORDER];
    hiddenColumns.clear();
    resetColumnInteractionState();
    persistColumnSettings();
  }

  function optionsWithCurrent(options: string[], value: string): string[] {
    if (!value || options.includes(value)) return options;
    return [value, ...options];
  }

  let tableRows = $state.raw<EditableInputRow[]>(getInitialTableRows());
  let draftBaseTableRows = $state.raw<EditableInputRow[]>(getInitialTableRows());
  let syncedRowsProp = getInitialRowsProp();
  // Single always-editable grid: `tableRows` is the live source of truth.
  // Incoming store updates are reconciled into it via syncRowsFromLiveQuery
  // (skipped while the user has uncommitted local edits).
  const displayedRows = $derived(tableRows);
  // Indices (into displayedRows) of rows that currently show a due-action badge.
  // Used to step the selector up/down between badges, skipping rows without one.
  const dueRowIndices = $derived(
    displayedRows.reduce<number[]>((acc, row, i) => {
      if (isDueConfirmation(row)) acc.push(i);
      return acc;
    }, []),
  );

  // Keyed by stable row id — holds the raw typed string while the user is mid-entry
  // so we never clobber it with the lbs→display round-trip conversion on every keystroke.
  const weightDrafts = new SvelteMap<string, string>();

  const shotLocationSelectOptions = $derived(['', ...$shotLocationOptions]);
  let newSymptomOption = $state('');
  let newSymptomColor = $state('#c8ccd4');
  let newShotLocationOption = $state('');
  let optionDeleteRequest = $state<OptionDeleteRequest | null>(null);

  let isSavingRows = $state(false);
  let expandedDueId = $state<string | null>(null);
  const todayKey = $derived(localDateKey());

  // ── Mobile per-card edit ───────────────────────────────────────────────────
  // On phones (≤640px) the table re-flows to one card per row and the desktop
  // keyboard-grid model is disabled entirely. Instead each card has its own Edit
  // button: it opens THAT card (by row identity), reveals every field, and shows
  // Save / Cancel / Delete. Edits are buffered (Cancel reverts from a snapshot;
  // autosave is suppressed while a card is open) so only Save persists.
  let mobileEditId = $state<string | null>(null);
  let mobileEditSnapshot: EditableInputRow | null = null;
  let rowDeleteRequest = $state<EditableInputRow | null>(null);
  // True only while a mobile card is being edited — gates the autosave path so
  // buffered edits don't persist until Save.
  const mobileEditingActive = $derived($isMobile && mobileEditId !== null);
  function isRowMobileEditing(row: EditableInputRow): boolean {
    return $isMobile && mobileEditId !== null && rowIdentity(row) === mobileEditId;
  }
  function startMobileEdit(row: EditableInputRow) {
    mobileEditId = rowIdentity(row) ?? null;
    mobileEditSnapshot = mobileEditId ? cloneRow(row) : null;
  }
  function saveMobileEdit(row: EditableInputRow) {
    // Flush any deferred dose PK recompute so the saved/derived state is current.
    commitDosePk();
    // Clear edit state first so the autosave guard no longer suppresses the
    // persist; `queueRowSaveFor` re-resolves the row by identity, so passing the
    // (possibly stale after recalc) row object is safe.
    mobileEditId = null;
    mobileEditSnapshot = null;
    queueRowSaveFor(row);
  }
  function cancelMobileEdit(row: EditableInputRow) {
    // Discarding edits — drop any pending dose PK recompute too.
    cancelDosePk();
    const id = rowIdentity(row);
    const snap = mobileEditSnapshot;
    mobileEditId = null;
    mobileEditSnapshot = null;
    if (!snap) return;
    weightDrafts.delete(rowKey(row, tableRows.findIndex((r) => rowIdentity(r) === id)));
    tableRows = recalculateDerived(
      tableRows.map((r) => (rowIdentity(r) === id ? snap : r)),
      true,
      snap.date || undefined,
    );
  }

  // ── Spreadsheet selection + Excel-style two-state editing ──────────────────
  // A cell is either *selected* (arrow keys move between cells; Enter / F2 /
  // typing begins editing) or *editing* (its control is focused; Enter / Tab
  // commit & move, Esc cancels). `selRow` is an absolute index into
  // displayedRows (= tableRows); `selCol` indexes activeColumns.
  let selRow = $state<number | null>(null);
  let selCol = $state<number | null>(null);
  let editing = $state(false);
  // The vial-attribution chip lives inside the dose cell but is its own selector
  // stop, immediately left of the dose number. When `selVial` is true the
  // selection sits on that chip (selCol points at the dose column); the dose
  // <td> still holds keyboard focus, but its edit ring is suppressed and the
  // chip is highlighted instead.
  let selVial = $state(false);
  // The due-action badge sits left of the leftmost cell, on rows that have one.
  // `selDue` puts the selection on it; `duePanelNav` tracks which panel button
  // (Taken/Skip) is highlighted while the confirm panel is open via keyboard.
  let selDue = $state(false);
  let duePanelNav = $state<'taken' | 'skipped' | null>(null);
  let editSeed: string | null = null;
  let editSnapshotRow: EditableInputRow | null = null;

  // Computed/read-only columns: selectable but never editable. Picker columns
  // render their dropdown control inline (always look like a dropdown); the rest
  // are two-state text cells (plain text until clicked/typed). Date is two-state
  // (formatted text → date input).
  const READONLY_COLS = new Set<ColumnKey>(['day', 'system', 'loss']);
  const PICKER_COLS = new Set<ColumnKey>(['symptoms', 'shotLocation']);
  function isEditableColumn(key: ColumnKey): boolean {
    return !READONLY_COLS.has(key);
  }
  function isTextColumn(key: ColumnKey): boolean {
    return isEditableColumn(key) && !PICKER_COLS.has(key);
  }
  // The cell that holds keyboard focus (drives tabindex / focus / empty-cell).
  function isSelected(r: number, c: number): boolean {
    return selRow === r && selCol === c;
  }
  // The cell that shows the selection ring — same as focus, except when the
  // selection is on the vial chip (then the chip is highlighted, not the cell).
  function isRingSelected(r: number, c: number): boolean {
    return selRow === r && selCol === c && !selVial && !selDue;
  }
  function isVialSelected(r: number): boolean {
    return selVial && selRow === r;
  }
  function isDueSelected(r: number): boolean {
    return selDue && selRow === r;
  }
  function isCellEditing(r: number, c: number): boolean {
    return editing && selRow === r && selCol === c && !selVial;
  }

  function cellRef(r: number, c: number): HTMLElement | null {
    return tableEl?.querySelector<HTMLElement>(`td[data-cell="${r}-${c}"]`) ?? null;
  }

  // Keep the DOM focus in step with the selection/edit state. The selected row
  // is, by construction, within the rendered virtualization window.
  $effect(() => {
    // The due-action badge manages its own focus (it lives outside the cell grid).
    if (selDue) return;
    if (selRow === null || selCol === null) return;
    const r = selRow;
    const c = selCol;
    const ed = editing;
    void tick().then(() => {
      const cell = cellRef(r, c);
      if (!cell) return;
      // Only move focus when EDITING starts (focus the inline editor). Cell
      // focus for plain navigation is done explicitly by moveSelection/commit so
      // we never steal focus back when the user tabs away from the grid.
      if (!ed) return;
      const ctrl = cell.querySelector<HTMLElement>('input, textarea');
      // No text editor in the cell (e.g. the symptoms multi-select / vial
      // picker) → leave focus management to that control.
      if (!ctrl) return;
      // preventScroll: the user is already looking at this cell (they clicked
      // or arrowed to it) — focusing the editor must not snap the window.
      ctrl.focus({ preventScroll: true });
      if (ctrl instanceof HTMLInputElement && editSeed === null && ctrl.type !== 'date') {
        const len = ctrl.value.length;
        try { ctrl.setSelectionRange(len, len); } catch { /* number inputs reject */ }
      }
    });
  });

  // Focus the active cell's <td> (preventScroll so it never fights an explicit
  // scroll). Used by keyboard navigation and commit — NOT reactively, so tabbing
  // away from the grid is never undone.
  function focusSelectedCell() {
    void tick().then(() => {
      if (selRow === null || selCol === null) return;
      cellRef(selRow, selCol)?.focus({ preventScroll: true });
    });
  }

  function selectCell(r: number, c: number, startEdit = false) {
    const key = activeColumns[c]?.key;
    selRow = r;
    selCol = c;
    selVial = false;
    selDue = false;
    const canEdit = !!key && isTextColumn(key);
    editing = startEdit && canEdit;
    editSeed = null;
    editSnapshotRow = editing ? cloneRow(tableRows[r]) : null;
  }

  // Put the selection on the vial chip (the dose cell's sub-stop). `open` opens
  // the menu immediately — used for a mouse click on the chip; arrow-key landing
  // leaves it closed until Enter.
  function setVialSelection(r: number, open = false) {
    if (doseColIndex < 0) return;
    selRow = r;
    selCol = doseColIndex;
    selVial = true;
    editing = open;
    editSeed = null;
    editSnapshotRow = null;
  }

  function beginEdit(seed: string | null = null) {
    if (selRow === null || selCol === null) return;
    if (selVial) {
      // Open the vial picker (it manages its own option focus via forceOpen).
      editing = true;
      return;
    }
    const key = activeColumns[selCol]?.key;
    if (!key) return;
    if (PICKER_COLS.has(key)) {
      // Symptoms + shot location open their menu via forceOpen (isCellEditing)
      // and manage their own option focus — a single Enter opens, arrows/space/
      // enter navigate and select, Esc/select returns focus to the cell.
      editing = true;
      return;
    }
    if (!isTextColumn(key)) return;
    editSnapshotRow = cloneRow(tableRows[selRow]);
    editSeed = seed;
    if (seed !== null) {
      // Weight rides a display-string draft buffer (so the lbs round-trip never
      // clobbers mid-typing); every other text cell seeds straight in.
      if (key === 'weight') weightDrafts.set(rowKey(tableRows[selRow], selRow), seed);
      else updateCell(selRow, key, seed);
    }
    editing = true;
  }

  function cancelEdit() {
    cancelDosePk();
    if (selRow !== null && editSnapshotRow) {
      const r = selRow;
      const snap = editSnapshotRow;
      weightDrafts.delete(rowKey(tableRows[r], r));
      tableRows = recalculateDerived(
        tableRows.map((row, i) => (i === r ? snap : row)),
        true,
        snap.date || undefined,
      );
    }
    editSeed = null;
    editSnapshotRow = null;
    editing = false;
    focusSelectedCell();
  }

  function moveSelection(dr: number, dc: number) {
    if (selRow === null || selCol === null) {
      selectCell(0, 0);
      return;
    }

    // ── On the due-action badge ──────────────────────────────────────────────
    if (selDue) {
      if (dr !== 0) {
        // Up/down jumps to the prev/next row that has a badge (skipping the
        // rest), however far away it is.
        const cur = dueRowIndices.indexOf(selRow);
        const ni = cur + (dr > 0 ? 1 : -1);
        if (cur < 0 || ni < 0 || ni >= dueRowIndices.length) return;
        const target = dueRowIndices[ni];
        selRow = target;
        selCol = 0;
        void bringRowIntoView(target).then(() => focusDueButton(target));
      } else if (dc > 0) {
        // Right → leave the badge for the leftmost cell of the same row.
        selDue = false;
        selectCell(selRow, 0);
        void tick().then(() => {
          if (selRow === null) return;
          const cell = cellRef(selRow, 0);
          if (cell) scrollCellIntoView(cell);
        });
      }
      // Left → clamp (nothing is further left than the badge).
      return;
    }

    const maxRow = Math.max(0, displayedRows.length - 1);
    const maxCol = Math.max(0, activeColumns.length - 1);
    const hasVialStop = doseColIndex >= 0;

    if (dr !== 0) {
      // Vertical: keep the column (and the vial sub-stop), change row.
      const r = Math.min(Math.max(selRow + dr, 0), maxRow);
      if (selVial) setVialSelection(r);
      else selectCell(r, selCol);
    } else if (dc > 0) {
      // Rightward: … [col-left-of-dose] → [VIAL] → [dose number] → …
      if (selVial) selectCell(selRow, doseColIndex);
      else if (hasVialStop && selCol === doseColIndex - 1) setVialSelection(selRow);
      else selectCell(selRow, Math.min(selCol + 1, maxCol));
    } else if (dc < 0) {
      // Leftward: badge (if any) sits left of the leftmost cell; then vial; etc.
      if (selVial) {
        if (doseColIndex - 1 < 0) return; // vial is the leftmost stop; clamp
        selectCell(selRow, doseColIndex - 1);
      } else if (hasVialStop && selCol === doseColIndex) {
        setVialSelection(selRow);
      } else if (selCol === 0 && dueRowIndices.includes(selRow)) {
        setDueSelection(selRow);
        return; // badge manages its own focus/scroll
      } else {
        selectCell(selRow, Math.max(selCol - 1, 0));
      }
    }

    // Arrow navigation explicitly focuses the target cell and scrolls it into
    // view (the focus effect is editor-only now, and never auto-scrolls). Done
    // manually rather than scrollIntoView so we can keep the row clear of the
    // page's sticky header when going up.
    void tick().then(() => {
      if (selRow === null || selCol === null) return;
      const cell = cellRef(selRow, selCol);
      if (!cell) return;
      cell.focus({ preventScroll: true });
      scrollCellIntoView(cell);
    });
  }

  // Scroll just enough to reveal a cell, leaving room above for the sticky
  // page header (the dashboard tab bar) — otherwise arrowing up parks the row
  // behind it. A no-op when the cell is already fully visible.
  function scrollCellIntoView(cell: HTMLElement) {
    const bar = document.querySelector('.tabbar');
    const barRect = bar?.getBoundingClientRect();
    const safeTop = barRect && barRect.top <= 1 ? barRect.bottom : 0;
    const rect = cell.getBoundingClientRect();
    if (rect.top < safeTop) {
      window.scrollBy({ top: rect.top - safeTop, left: 0, behavior: 'auto' });
    } else if (rect.bottom > window.innerHeight) {
      window.scrollBy({ top: rect.bottom - window.innerHeight, left: 0, behavior: 'auto' });
    }
  }

  // Commit the current edit: persist, exit edit mode, and re-sort by date so a
  // changed date reorders immediately. The selection stays on the SAME row
  // (tracked by identity) — it does NOT move — and the window scrolls to keep
  // that row visually put. Arrow keys can then move the selector again.
  async function commitEdit(): Promise<void> {
    if (selRow === null || selCol === null) {
      editing = false;
      return;
    }
    // Flush a deferred dose PK recompute first so the re-sort + save see it.
    commitDosePk();
    const r = selRow;
    const c = selCol;
    const id = rowIdentity(tableRows[r]);
    const beforeTop = cellRef(r, c)?.getBoundingClientRect().top ?? null;

    editing = false;
    editSeed = null;
    editSnapshotRow = null;
    if (id) queueRowSave(r);

    // Re-sort now (date order) instead of waiting for the async save round-trip.
    tableRows = recalculateDerived(tableRows.map(cloneRow), false);
    const newIndex = id ? tableRows.findIndex((row) => rowIdentity(row) === id) : r;
    selRow = newIndex >= 0 ? newIndex : Math.min(r, tableRows.length - 1);

    if (beforeTop === null || selRow === null || selCol === null) return;

    // Suspend the scroll handler's own anchor compensation while we drive the
    // scroll ourselves, so it doesn't fight the follow.
    suppressScrollSettle = true;
    isUserScrolling = true;

    // The row may have re-sorted far outside the rendered window. Estimate its
    // document position from the prefix-offset table and jump there so the row
    // renders, landing it at its previous on-screen position. (Heights for
    // far rows are estimates; the fine-correct below fixes residual error once
    // the real row is rendered.)
    ensureLen(displayedRows.length);
    rebuildPrefix();
    const tbodyDocTop = tbodyTop() + window.scrollY;
    const target = tbodyDocTop + prefix[selRow] - beforeTop;
    window.scrollTo({ top: Math.max(0, target), left: 0, behavior: 'auto' });

    await tick();
    recomputeVisibleRange();
    await tick();

    // Fine-correct using the now-rendered cell's real position.
    const cell = cellRef(selRow, selCol);
    if (cell) {
      const afterTop = cell.getBoundingClientRect().top;
      if (Math.abs(afterTop - beforeTop) > 0.5) {
        window.scrollBy({ top: afterTop - beforeTop, left: 0, behavior: 'auto' });
      }
      cell.focus({ preventScroll: true });
    }

    // Release after the scrolls' events have settled so a later genuine scroll
    // re-arms normally.
    requestAnimationFrame(() => {
      isUserScrolling = false;
      suppressScrollSettle = false;
    });
  }

  function isPrintableKey(e: KeyboardEvent): boolean {
    return e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey;
  }

  // Return focus from an inner control (dropdown / input) back to the cell, so
  // arrow-key grid navigation resumes.
  function exitToCell(r: number, c: number) {
    editing = false;
    selVial = false;
    selRow = r;
    selCol = c;
    void tick().then(() => cellRef(r, c)?.focus());
  }

  // Close the vial picker but keep the selection on the vial chip (so it stays
  // highlighted and arrow keys resume from there). Focus returns to the dose td.
  function exitToVial(r: number) {
    editing = false;
    selRow = r;
    selCol = doseColIndex;
    selVial = true;
    void tick().then(() => cellRef(r, doseColIndex)?.focus());
  }

  function cellKeydown(e: KeyboardEvent, r: number, c: number) {
    // Only navigate when the cell itself holds focus. Once focus is inside an
    // inner control (text input, date input, or an open dropdown), that control
    // owns the arrow / Enter keys, so the cell must not steal them — except
    // Escape, which hands focus back to the cell for grid navigation.
    if (e.target !== e.currentTarget) {
      if (e.key === 'Escape') exitToCell(r, c);
      return;
    }
    // The grid was tabbed into with nothing active yet — adopt the focused cell
    // so the first key acts on it.
    if (selRow === null) {
      selRow = r;
      selCol = c;
    }
    switch (e.key) {
      // Tab / Shift+Tab are deliberately NOT handled — they fall through to the
      // browser so focus moves to the next/previous element on the page.
      case 'ArrowDown': e.preventDefault(); moveSelection(1, 0); return;
      case 'ArrowUp': e.preventDefault(); moveSelection(-1, 0); return;
      case 'ArrowLeft': e.preventDefault(); moveSelection(0, -1); return;
      case 'ArrowRight': e.preventDefault(); moveSelection(0, 1); return;
      case 'Enter':
      case 'F2': e.preventDefault(); beginEdit(); return;
      case 'Escape': return;
      case 'Delete':
      case 'Backspace': {
        if (selVial) { e.preventDefault(); clearVialOverride(r); return; }
        const key = activeColumns[c]?.key;
        if (key && isEditableColumn(key)) { e.preventDefault(); clearCell(r, key); }
        return;
      }
      default:
        // On the vial sub-stop, printable keys don't seed a dose value.
        if (!selVial && isPrintableKey(e)) { e.preventDefault(); beginEdit(e.key); }
    }
  }

  // Shared by every text editor incl. the notes textarea. Plain Enter commits
  // in place (for notes too — so Enter saves rather than inserting a newline);
  // Shift+Enter is left to the browser (newline in a textarea, no-op elsewhere).
  // Esc cancels. Tab is left to the browser so focus moves out of the grid
  // normally (the editor's blur commits + stops editing). stopPropagation so the
  // committed key doesn't bubble to cellKeydown and re-enter edit mode.
  function editorKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      void commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  }

  // An editor lost focus (tab/click away): persist and leave edit mode, but
  // don't pull focus back — let it land wherever the user sent it.
  function editorBlur(row: EditableInputRow) {
    // Flush a deferred dose PK recompute so the save reflects the typed dose.
    commitDosePk();
    editing = false;
    queueRowSaveFor(row);
  }

  function clearCell(r: number, key: ColumnKey) {
    // This computes its own derived state; drop any deferred dose recompute.
    cancelDosePk();
    if (key === 'symptoms') updateCell(r, 'symptoms', []);
    else if (key === 'dose') {
      // Clearing a dose also drops its vial override / medication attribution.
      tableRows = recalculateDerived(
        tableRows.map((row, i) => (i === r ? { ...cloneRow(row), dose: '', prescriptionId: undefined } : row)),
        true,
        tableRows[r]?.date || undefined,
        'pk',
      );
    } else updateCell(r, key, '');
    queueRowSave(r);
  }

  // ── Auto-save ──────────────────────────────────────────────────────────────
  // Persist a single row on commit (blur / Enter / Tab / picker select). Saves
  // are serialized through one promise chain and re-resolve the row by identity,
  // so a draft never double-inserts even under rapid edits.
  let pendingRowSave: Promise<void> = Promise.resolve();
  function rowIdentity(row: EditableInputRow): string | undefined {
    return row.draftId ?? row.entryId;
  }
  function queueRowSave(rowIndex: number) {
    const row = tableRows[rowIndex];
    if (row) queueRowSaveFor(row);
  }
  // Save by row identity, not index — blur handlers can fire after a commit has
  // re-sorted the table, so the original render-time index may now point at a
  // different row.
  function queueRowSaveFor(row: EditableInputRow) {
    // While a mobile card is open, edits are buffered — only its Save button
    // persists (which clears mobileEditId first, so this guard then passes).
    if (mobileEditingActive) return;
    const id = rowIdentity(row);
    if (!id) return;
    pendingRowSave = pendingRowSave.catch(() => undefined).then(() => autosaveByIdentity(id));
  }
  async function autosaveByIdentity(id: string) {
    const rowIndex = tableRows.findIndex((r) => rowIdentity(r) === id);
    if (rowIndex < 0) return;
    commitWeightDraftFor(rowIndex);
    const freshIndex = tableRows.findIndex((r) => rowIdentity(r) === id);
    if (freshIndex < 0) return;
    const row = tableRows[freshIndex];
    if (isDraftRow(row) && !hasPersistableData(row)) return; // empty draft: nothing to persist
    isSavingRows = true;
    try {
      const confirmedAt = shouldConfirmEditedPlannedDose(row, freshIndex)
        ? new Date().toISOString()
        : undefined;
      const saveInput = toSaveInputRow(normalizeWellnessRow(stripDraftMetadata(row)), confirmedAt);
      const [saved] = await saveInputRows([saveInput], {
        defaultMedication: defaultMedication as Medication | '',
      });
      const merged = mergeSavedInputRow(row, saved) as EditableInputRow;
      tableRows = tableRows.map((r) => (rowIdentity(r) === id ? merged : r));
      markRowsAsBaseline();
    } catch (err) {
      console.error('Failed to save row:', err);
    } finally {
      isSavingRows = false;
    }
  }

  function commitWeightDraftFor(rowIndex: number) {
    const row = tableRows[rowIndex];
    if (!row) return;
    const key = rowKey(row, rowIndex);
    const draft = weightDrafts.get(key);
    if (draft === undefined) return;
    const next = cloneRow(row);
    next.weight = toStoredLbs(draft, $weightUnit);
    tableRows = recalculateDerived(
      tableRows.map((r, i) => (i === rowIndex ? next : r)),
      true,
      next.date || undefined,
      'weight',
    );
    weightDrafts.delete(key);
  }

  // ── Dose cell vial / drug selection ─────────────────────────────────────────
  const vialOptions = $derived(
    $medicationRows
      .filter((m) => !m.archived && m.type)
      .map((m) => ({ id: m.id, dbId: m.dbId, type: m.type as string })),
  );
  function pickVial(rowIndex: number, dbId: string, type: string) {
    tableRows = recalculateDerived(
      tableRows.map((r, i) =>
        i === rowIndex ? { ...cloneRow(r), prescriptionId: dbId, medication: type } : r,
      ),
      true,
      tableRows[rowIndex]?.date || undefined,
      'pk',
    );
    queueRowSave(rowIndex);
  }
  function pickDrug(rowIndex: number, med: string) {
    updateCell(rowIndex, 'medication', med);
    queueRowSave(rowIndex);
  }
  function clearVialOverride(rowIndex: number) {
    tableRows = recalculateDerived(
      tableRows.map((r, i) => (i === rowIndex ? { ...cloneRow(r), prescriptionId: undefined } : r)),
      true,
      tableRows[rowIndex]?.date || undefined,
      'pk',
    );
    queueRowSave(rowIndex);
  }

  function isDueConfirmation(row: EditableInputRow): boolean {
    return (
      !!row.entryId &&
      row.dosePlanned === true &&
      !row.doseSkipped &&
      typeof row.date === 'string' &&
      row.date <= todayKey
    );
  }

  function patchRowById(rows: EditableInputRow[], entryId: string, patch: Partial<HealthInputRow>): EditableInputRow[] {
    return rows.map((row) => (row.entryId === entryId ? { ...cloneRow(row), ...patch } : row));
  }

  async function applyDoseDecision(row: EditableInputRow, decision: 'taken' | 'skipped') {
    if (!row.entryId) return;
    const id = row.entryId;
    const patch: Partial<HealthInputRow> =
      decision === 'taken'
        ? { dosePlanned: false, doseSkipped: false, doseConfirmedAt: new Date().toISOString() }
        : { dosePlanned: false, doseSkipped: true, doseConfirmedAt: undefined };

    const affectedDate = tableRows.find((r) => r.entryId === id)?.date;
    tableRows = recalculateDerived(patchRowById(tableRows, id, patch), false, affectedDate, 'pk');
    draftBaseTableRows = patchRowById(draftBaseTableRows, id, patch);
    expandedDueId = null;

    try {
      await updateEntry(id, {
        planned: false,
        confirmedAt: decision === 'taken' ? patch.doseConfirmedAt : undefined,
        skipped: decision === 'skipped',
      });
    } catch (err) {
      console.error('Failed to update dose status:', err);
    }
  }

  // Mouse click on the badge: select it (so the keyboard model is consistent)
  // and toggle the confirm panel open/closed.
  function activateDueFromClick(r: number, row: EditableInputRow) {
    selRow = r;
    selCol = 0;
    selVial = false;
    selDue = true;
    editing = false;
    if (expandedDueId === row.entryId) {
      expandedDueId = null;
      duePanelNav = null;
      focusDueButton(r);
    } else {
      openDuePanelKeyboard();
    }
  }

  // ── Due-action badge: grid-selection + keyboard control ────────────────────
  function setDueSelection(r: number) {
    selRow = r;
    selCol = 0;
    selVial = false;
    selDue = true;
    editing = false;
    focusDueButton(r);
  }

  function focusDueButton(r: number) {
    void tick().then(() => {
      inputsTableRegion
        ?.querySelector<HTMLElement>(`.due-action-btn[data-due-row="${r}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  // Reveal a row that may be far outside the rendered window, then settle it on
  // screen. Mirrors commitEdit's prefix-estimate jump.
  async function bringRowIntoView(rowIndex: number) {
    let cell = cellRef(rowIndex, 0);
    if (!cell) {
      ensureLen(displayedRows.length);
      rebuildPrefix();
      const tbodyDocTop = tbodyTop() + window.scrollY;
      const target = tbodyDocTop + prefix[rowIndex] - window.innerHeight / 2;
      window.scrollTo({ top: Math.max(0, target), left: 0, behavior: 'auto' });
      await tick();
      recomputeVisibleRange();
      await tick();
      cell = cellRef(rowIndex, 0);
    }
    if (cell) scrollCellIntoView(cell);
  }

  function dueButtonKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        openDuePanelKeyboard();
        return;
      case 'ArrowRight':
        event.preventDefault();
        event.stopPropagation();
        moveSelection(0, 1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        event.stopPropagation();
        return;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        moveSelection(-1, 0);
        return;
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        moveSelection(1, 0);
        return;
    }
  }

  function openDuePanelKeyboard() {
    if (selRow === null) return;
    const row = displayedRows[selRow];
    if (!row?.entryId) return;
    expandedDueId = row.entryId;
    duePanelNav = 'taken';
    void tick().then(focusDuePanelButton);
  }

  function focusDuePanelButton() {
    if (selRow === null) return;
    const cls = duePanelNav === 'skipped' ? '.due-action-skip' : '.due-action-confirm';
    inputsTableRegion
      ?.querySelector<HTMLElement>(`.due-action-panel[data-due-row="${selRow}"] ${cls}`)
      ?.focus({ preventScroll: true });
  }

  function duePanelKeydown(event: KeyboardEvent, row: EditableInputRow) {
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        duePanelNav = 'taken';
        focusDuePanelButton();
        return;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        duePanelNav = 'skipped';
        focusDuePanelButton();
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        confirmDue(row, duePanelNav ?? 'taken');
        return;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        closeDuePanelKeyboard();
        return;
    }
  }

  // Apply the decision then drop the selector back on the row's leftmost cell.
  function confirmDue(row: EditableInputRow, decision: 'taken' | 'skipped') {
    const r = selRow;
    duePanelNav = null;
    void applyDoseDecision(row, decision);
    if (selDue && r !== null) {
      selDue = false;
      selectCell(r, 0);
      void tick().then(() => cellRef(r, 0)?.focus({ preventScroll: true }));
    }
  }

  // Close the panel but keep the badge selected (Esc from the panel).
  function closeDuePanelKeyboard() {
    expandedDueId = null;
    duePanelNav = null;
    if (selRow !== null) focusDueButton(selRow);
  }

  // Vertically center each (desktop) due badge on its row. The badge is absolute
  // against `.inputs-table-region` to escape the scroll clip, so it can't use a
  // cell-relative top:50% — we measure the row box and set top in px instead.
  function positionDueBadges() {
    if (!inputsTableRegion) return;
    const wraps = inputsTableRegion.querySelectorAll<HTMLElement>('.due-action-wrap');
    const desktop =
      typeof window !== 'undefined' && window.matchMedia('(min-width: 641px)').matches;
    if (!desktop) {
      for (const wrap of wraps) wrap.style.top = '';
      return;
    }
    const regionTop = inputsTableRegion.getBoundingClientRect().top;
    for (const wrap of wraps) {
      const cell = wrap.closest('td');
      if (!cell) continue;
      const rect = cell.getBoundingClientRect();
      wrap.style.top = `${rect.top - regionTop + rect.height / 2}px`;
    }
  }

  function handleDocumentClickForDuePanel(event: MouseEvent) {
    if (expandedDueId === null) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    const wraps = inputsTableRegion?.querySelectorAll('.due-action-wrap') ?? [];
    for (const wrap of wraps) {
      if (wrap.contains(target)) return;
    }
    expandedDueId = null;
    duePanelNav = null;
  }

  let nextDraftRowId = 0;
  let lastAddRowSignal = getInitialAddRowSignal();
  let lastDefaultMedication = '';

  $effect(() => {
    if (rows === syncedRowsProp) return;
    syncedRowsProp = rows;
    syncRowsFromLiveQuery(rows);
  });

  $effect(() => {
    if (addRowSignal === lastAddRowSignal) return;
    lastAddRowSignal = addRowSignal;
    addDraftRow();
  });

  $effect(() => {
    if (defaultMedication === lastDefaultMedication) return;
    lastDefaultMedication = defaultMedication;
    if (!editing) {
      tableRows = recalculateDerived(tableRows.map(cloneRow));
    }
  });

  $effect(() => {
    if (!defaultMedication || !tableRows.some((row) => isDraftRow(row) && !row.medication)) return;
    tableRows = recalculateDerived(
      tableRows.map((row) => (isDraftRow(row) && !row.medication ? { ...row, medication: defaultMedication } : row)),
      true,
    );
  });

  $effect(() => {
    if (columnSettingsOpen) return;
    resetColumnInteractionState();
  });

  const visibleColumns = $derived(
    columns.filter((column) => !hiddenColumns.has(column.key)),
  );
  const hiddenColumnOptions = $derived(columns.filter((column) => hiddenColumns.has(column.key)));
  const activeColumns = $derived(visibleColumns);
  // Index of the dose column (the vial sub-stop sits just left of it).
  const doseColIndex = $derived(activeColumns.findIndex((c) => c.key === 'dose'));
  const stretchColumnKey = $derived(
    activeColumns.some((column) => column.key === 'notes')
      ? 'notes'
      : activeColumns[activeColumns.length - 1]?.key,
  );
  const weightDecimals = $derived(
    columnDecimals(displayedRows.map((r) => lbsToDisplayNum(r.weight, $weightUnit)))
  );
  const doseDecimals = $derived(
    columnDecimals(displayedRows.map((r) => parseFloat(r.dose)))
  );
  const showSystemMedicationLetters = $derived.by(() => {
    const medications = displayedRows
      .filter((row) => Number.isFinite(parseFloat(row.dose)) && parseFloat(row.dose) > 0)
      .map((row) => resolveDoseMedication(row))
      .filter(Boolean);
    return new Set(medications).size > 1;
  });

  // ── Row virtualization ───────────────────────────────────────────────────
  // The table scrolls with the page (no fixed-height container). We render
  // only rows whose absolute index falls within the visible window plus an
  // overscan, and emit top/bottom spacer rows to preserve total height. This
  // keeps both entering edit mode and returning to view mode O(visible rows)
  // instead of O(all history).
  // Variable-height windowing. Rows are not uniform — on mobile they become
  // cards with empty fields hidden, so heights vary a lot. We keep a measured
  // height per row (estimate until first seen) and cumulative prefix offsets so
  // the visible window, spacer heights, and scroll position stay accurate at
  // 1000+ rows. `prefix[i]` = summed height of rows [0, i); length n+1.
  const ROW_OVERSCAN = 8;
  const DEFAULT_ROW_HEIGHT = 40;
  let tableEl: HTMLTableElement | undefined = $state();
  let firstVisibleIndex = $state(0);
  let lastVisibleIndex = $state(80);
  let topSpacerHeight = $state(0);
  let bottomSpacerHeight = $state(0);

  // Plain (non-reactive) caches mutated imperatively; the $state above is what
  // drives rendering. `measured[i]` marks rows whose real height we've seen.
  let rowHeights: number[] = [];
  let rowMeasured: boolean[] = [];
  let prefix: number[] = [0];
  let estimate = DEFAULT_ROW_HEIGHT;

  // True while the user is actively scrolling (including the momentum tail).
  // Scroll-anchor compensation (`window.scrollBy`) and estimate drift are
  // suppressed during this window: a programmatic scroll mid-fling cancels the
  // browser's native momentum, and an estimate that keeps shifting re-anchors
  // the page every frame, so the two together make the page judder and the
  // scroll feel "stuck". We reconcile once when scrolling settles instead.
  let isUserScrolling = false;
  let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
  // Set while we drive a programmatic scroll (the bottom re-pin) so its own
  // scroll event doesn't re-arm the settle reconcile — otherwise the pin would
  // schedule another reconcile 150ms later that re-pins to a slightly different
  // bottom, which reads as a snap. The bottom convergence below already folds in
  // the freshly rendered rows within a few frames.
  let suppressScrollSettle = false;

  // A stable primitive: re-fires only when the count actually changes, unlike
  // `displayedRows` whose reference shifts on every keystroke.
  const displayedRowsLength = $derived(displayedRows.length);

  function heightAt(i: number): number {
    return rowMeasured[i] ? rowHeights[i] : estimate;
  }

  function rebuildPrefix() {
    const n = rowHeights.length;
    prefix = buildPrefix(Array.from({ length: n }, (_, i) => heightAt(i)));
  }

  function ensureLen(n: number) {
    const old = rowHeights.length;
    if (old === n) return;
    rowHeights.length = n;
    rowMeasured.length = n;
    for (let i = old; i < n; i += 1) {
      rowHeights[i] = estimate;
      rowMeasured[i] = false;
    }
    rebuildPrefix();
  }

  // Largest index i in [0, n] with prefix[i] <= target (the row at that offset).
  function indexAtOffset(target: number): number {
    return indexAtOffsetShared(prefix, target, rowHeights.length);
  }

  function tbodyTop(): number {
    const tbody = tableEl?.tBodies[0];
    return (tbody ?? tableEl)?.getBoundingClientRect().top ?? 0;
  }

  function recomputeVisibleRange() {
    if (!tableEl) return;
    const rowCount = displayedRows.length;
    ensureLen(rowCount);
    // Offsets are measured from the tbody's content top (= row 0's top), which
    // already excludes the thead and accounts for the current top spacer.
    const top = tbodyTop();
    const range = computeVisibleRange(
      prefix,
      rowCount,
      Math.max(0, -top),
      Math.max(0, window.innerHeight - top),
      ROW_OVERSCAN,
    );
    firstVisibleIndex = range.first;
    lastVisibleIndex = range.last;
    topSpacerHeight = range.topSpacer;
    bottomSpacerHeight = range.bottomSpacer;
  }

  // Measure the rendered (non-spacer) rows and fold their real heights into the
  // cache. If rows *above* the viewport top were re-measured (e.g. scrolling up
  // into not-yet-seen rows, or a card↔table switch), the anchored row would
  // shift, so we scroll-compensate by the offset delta to keep it put.
  // Fold the heights of the currently rendered rows into the cache, optionally
  // refining the running estimate, and rebuild the prefix. Returns whether
  // anything changed (so callers know if the total height moved).
  function foldRenderedHeights(updateEstimate: boolean): boolean {
    const tbody = tableEl?.tBodies[0];
    if (!tbody) return false;
    const rows = tbody.querySelectorAll<HTMLElement>('tr:not(.virtual-spacer)');
    if (rows.length === 0) return false;

    let changed = false;
    let total = 0;
    let count = 0;
    rows.forEach((el, i) => {
      const idx = firstVisibleIndex + i;
      if (idx < 0 || idx >= rowHeights.length) return;
      const h = el.getBoundingClientRect().height;
      if (h <= 0) return;
      total += h;
      count += 1;
      if (!rowMeasured[idx] || Math.abs(rowHeights[idx] - h) > 0.5) {
        rowHeights[idx] = h;
        rowMeasured[idx] = true;
        changed = true;
      }
    });

    let estimateChanged = false;
    if (updateEstimate && count > 0) {
      const nextEstimate = total / count;
      if (Math.abs(nextEstimate - estimate) > 0.5) {
        estimate = nextEstimate;
        estimateChanged = true;
      }
    }
    if (!changed && !estimateChanged) return false;
    rebuildPrefix();
    return true;
  }

  // Pin to the true bottom and converge over a few frames. A fast fling lands at
  // the *estimated* bottom with many skipped rows still unmeasured; each frame we
  // pin, let the freshly revealed bottom rows render, fold their real heights in,
  // and repeat until the total height stops moving. Doing this within a handful
  // of frames (rather than across 150ms settle gaps) makes it read as a smooth
  // settle instead of a delayed snap. `suppressScrollSettle` keeps our own pin
  // scrolls from arming a fresh reconcile.
  function reconcileBottom(passesLeft: number) {
    requestAnimationFrame(() => {
      if (!tableEl) {
        suppressScrollSettle = false;
        return;
      }
      const docEl = document.documentElement;
      const max = docEl.scrollHeight - window.innerHeight;
      if (window.scrollY < max - 0.5) {
        suppressScrollSettle = true;
        window.scrollTo({ top: max, left: 0, behavior: 'auto' });
      }
      const changed = foldRenderedHeights(true);
      if (changed) recomputeVisibleRange();
      if (changed && passesLeft > 0) {
        reconcileBottom(passesLeft - 1);
      } else {
        // Release the settle suppression after the final pin's scroll event has
        // had a frame to fire, so a genuine subsequent user scroll re-arms it.
        requestAnimationFrame(() => {
          suppressScrollSettle = false;
        });
      }
    });
  }

  // Measure the rendered (non-spacer) rows and fold their real heights into the
  // cache. If rows *above* the viewport top were re-measured (e.g. scrolling up
  // into not-yet-seen rows, or a card↔table switch), the anchored row would
  // shift, so we scroll-compensate by the offset delta to keep it put.
  function measureRenderedRows() {
    if (!tableEl) return;
    const tbody = tableEl.tBodies[0];
    if (!tbody) return;

    const scrolledPast = Math.max(0, -tbody.getBoundingClientRect().top);
    const anchorIndex = Math.min(indexAtOffset(scrolledPast), prefix.length - 1);
    const anchorBefore = prefix[anchorIndex];

    const docEl = document.documentElement;
    const atBottom = window.scrollY + window.innerHeight >= docEl.scrollHeight - 2;

    // Don't let the estimate drift mid-scroll: it changes the height of every
    // not-yet-measured row at once, which shifts the prefix above the anchor
    // and forces a compensation every frame. Reconciled on scroll-settle.
    if (!foldRenderedHeights(!isUserScrolling)) return;

    if (!isUserScrolling && atBottom) {
      // At the page bottom the browser already clamps scrollY when the content
      // height changes under us, so the model-based anchor compensation below
      // would double-correct and leave us a little short of the bottom. Pin to
      // the true bottom and converge the skipped-row heights instead.
      recomputeVisibleRange();
      reconcileBottom(3);
      return;
    }

    const anchorAfter = prefix[anchorIndex];
    const delta = anchorAfter - anchorBefore;
    // Skip scroll-anchor compensation while the user is scrolling — a
    // programmatic scroll mid-fling kills native momentum. Visited rows are
    // already measured (delta ≈ 0) during ordinary scrolling anyway; the rare
    // above-viewport correction is folded in by the scroll-settle reconcile.
    if (!isUserScrolling && Math.abs(delta) > 0.5) {
      window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
    }
    recomputeVisibleRange();
    positionDueBadges();
  }

  // Freeze vial attribution permanently. The moment a consuming dose has a
  // FIFO-chosen vial (by table order) and no stored one, persist that single
  // vial as the dose's `prescriptionId`. From then on the dose draws wholly from
  // that one vial — reordering vials or editing the medications table never
  // re-attributes it, and the remaining-mg math stays put. (Picking "Auto"
  // clears the stored vial, which re-snaps to the current order and re-freezes.)
  // Converges: once stored, a dose drops out of the auto map so the effect stops.
  const freezingIds = new Set<string>();
  $effect(() => {
    const map = $autoVialByEntryId;
    if (map.size === 0) return;
    const toFreeze = [...map.entries()].filter(([id]) => !freezingIds.has(id));
    if (toFreeze.length === 0) return;
    for (const [id] of toFreeze) freezingIds.add(id);
    void Promise.all(toFreeze.map(([id, dbId]) => updateEntry(id, { prescriptionId: dbId }))).finally(
      () => {
        for (const [id] of toFreeze) freezingIds.delete(id);
      },
    );
  });

  // Resize the cache and recompute when rows are added/removed.
  $effect(() => {
    displayedRowsLength;
    if (!tableEl) return;
    ensureLen(displayedRowsLength);
    recomputeVisibleRange();
  });

  // Re-center the due badges whenever the rendered slice or its geometry shifts.
  $effect(() => {
    visibleRows;
    topSpacerHeight;
    void tick().then(positionDueBadges);
  });

  $effect(() => {
    if (!tableEl) return;
    let scrollRaf = 0;
    let resizeRaf = 0;
    let lastWidth = tableEl.getBoundingClientRect().width;
    const onScroll = () => {
      // Our own bottom re-pin scrolls run with suppressScrollSettle set; they
      // still need the range recompute below to render the newly exposed rows,
      // but must not arm a fresh settle reconcile (that's what caused the
      // delayed bottom snap).
      if (!suppressScrollSettle) {
        isUserScrolling = true;
        if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
        // ~150ms after the last scroll event the fling has settled; fold in any
        // deferred estimate/anchor correction now that a scrollBy won't fight
        // momentum. By this point visited rows are measured, so the reconcile is
        // typically a no-op — it just makes the spacers exact.
        scrollIdleTimer = setTimeout(() => {
          isUserScrolling = false;
          measureRenderedRows();
        }, 150);
      }
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        recomputeVisibleRange();
      });
    };
    const onResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        // A width change (viewport resize, card↔table switch) invalidates every
        // cached height; drop them so rows re-measure as they scroll into view.
        const width = tableEl?.getBoundingClientRect().width ?? lastWidth;
        if (Math.abs(width - lastWidth) > 1) {
          lastWidth = width;
          rowMeasured.fill(false);
          rebuildPrefix();
        }
        measureRenderedRows();
        recomputeVisibleRange();
        positionDueBadges();
      });
    };
    // Also fires when the table goes 0 → real size (hidden tab becomes active).
    const tableObserver = new ResizeObserver(onResize);
    tableObserver.observe(tableEl);
    recomputeVisibleRange();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
      tableObserver.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  });

  // Measure after the rendered window changes (range/mode/count). Keystrokes do
  // NOT change these, so typing won't re-measure and yank focus/scroll.
  $effect(() => {
    firstVisibleIndex;
    lastVisibleIndex;
    displayedRowsLength;
    editing;
    if (!tableEl) return;
    queueMicrotask(measureRenderedRows);
  });

  const visibleRows = $derived(displayedRows.slice(firstVisibleIndex, lastVisibleIndex + 1));

  function nextDraftRowDate(): IsoDate {
    const latestDraftDate = maxDateKey(tableRows.filter(isDraftRow).map((row) => row.date));
    return latestDraftDate ? addDays(latestDraftDate, 1) : localDateKey();
  }

  function createEmptyRow(date: IsoDate = localDateKey()): HealthInputRow {
    return {
      day: calculateDay(date),
      date,
      system: '',
      systemAmounts: [],
      dose: '',
      dosePlanned: false,
      doseSkipped: false,
      medication: defaultMedication,
      weight: '',
      wellness: '',
      loss: '',
      symptoms: [],
      shotLocation: '',
      notes: '',
    };
  }

  function createDraftRow(): EditableInputRow {
    nextDraftRowId += 1;
    return { ...createEmptyRow(nextDraftRowDate()), draftId: `draft-${nextDraftRowId}` };
  }

  function isDraftRow(row: HealthInputRow): row is EditableInputRow & { draftId: string } {
    return typeof (row as EditableInputRow).draftId === 'string';
  }

  function addDraftRow() {
    const draft = createDraftRow();
    // The new row is empty — no derived field on any existing row changes.
    tableRows = recalculateDerived([draft, ...tableRows], true, draft.date || undefined, 'local');
    // On mobile open the fresh card in edit mode so all fields are ready to fill.
    if ($isMobile) startMobileEdit(draft);
  }

  async function deleteRow(row: EditableInputRow) {
    if (!isDraftRow(row)) {
      if (!confirm('Delete this row? This cannot be undone.')) return;
    }
    await performDeleteRow(row);
  }

  // The destructive half of deleteRow, without the native confirm — the mobile
  // per-card flow gates it behind the styled ConfirmDialog instead.
  async function performDeleteRow(row: EditableInputRow) {
    if (!isDraftRow(row) && row.entryId) await deleteEntry(row.entryId);
    tableRows = recalculateDerived(tableRows.filter((r) => r !== row));
  }

  function syncRowsFromLiveQuery(nextRows: HealthInputRow[]) {
    // If the incoming snapshot already matches our local state by content
    // (typical immediately after a save we just did), skip the recalc + clones.
    if (weightDrafts.size === 0 && rowsMatch(nextRows, tableRows)) return;

    const nextSavedRows = recalculateDerived(nextRows.map(cloneRow));
    const draftHasRowChanges = weightDrafts.size > 0 || !rowsMatch(tableRowsWithCommittedWeightDrafts(), draftBaseTableRows);

    if (draftHasRowChanges) return;

    weightDrafts.clear();
    tableRows = nextSavedRows.map(cloneRow);
    draftBaseTableRows = nextSavedRows.map(cloneRow);
  }

  function getInitialTableRows(): EditableInputRow[] {
    return recalculateDerived(rows.map(cloneRow));
  }

  function getInitialRowsProp(): HealthInputRow[] {
    return rows;
  }

  function getInitialAddRowSignal(): number {
    return addRowSignal;
  }

function markRowsAsBaseline() {
    draftBaseTableRows = tableRowsWithCommittedWeightDrafts().map(cloneRow);
    weightDrafts.clear();
  }

  function tableRowsWithCommittedWeightDrafts(): EditableInputRow[] {
    if (weightDrafts.size === 0) return tableRows.map(cloneRow);

    return tableRows.map((row, index) => {
      const key = rowKey(row, index);
      const draft = weightDrafts.get(key);
      if (draft === undefined) return cloneRow(row);
      return { ...cloneRow(row), weight: toStoredLbs(draft, $weightUnit) };
    });
  }

  function comparableRows(sourceRows: HealthInputRow[]): unknown[] {
    return sourceRows.map((row) => {
      const { system, systemAmounts, day, loss, ...persistedFields } = stripDraftMetadata(row as EditableInputRow);
      return {
        ...persistedFields,
        symptoms: [...persistedFields.symptoms],
      };
    });
  }

  function rowsMatch(left: HealthInputRow[], right: HealthInputRow[]): boolean {
    return JSON.stringify(comparableRows(left)) === JSON.stringify(comparableRows(right));
  }

  function hasPersistableData(row: HealthInputRow): boolean {
    return (
      parseWeight(row.weight) !== null ||
      !!row.wellness ||
      row.symptoms.length > 0 ||
      !!row.notes ||
      Number.isFinite(parseFloat(row.dose))
    );
  }

  function rowKey(row: EditableInputRow, rowIndex: number): string {
    return row.draftId ?? row.entryId ?? `${row.date}-${rowIndex}`;
  }

  function rowBaseline(row: EditableInputRow, tableIndex: number): EditableInputRow | undefined {
    const key = rowKey(row, tableIndex);
    return draftBaseTableRows.find((candidate, candidateIndex) => rowKey(candidate, candidateIndex) === key);
  }

  function rowHasUserChanges(row: EditableInputRow, tableIndex: number): boolean {
    const baseline = rowBaseline(row, tableIndex);
    if (!baseline) return true;
    return !rowsMatch([row], [baseline]);
  }

  function shouldConfirmEditedPlannedDose(row: EditableInputRow, tableIndex: number): boolean {
    return (
      !!row.entryId &&
      row.dosePlanned === true &&
      row.doseSkipped !== true &&
      !row.doseConfirmedAt &&
      rowHasUserChanges(row, tableIndex)
    );
  }

  function toSaveInputRow(row: HealthInputRow, confirmedAt?: string): HealthInputRowSaveInput {
    const weightLbs = parseWeight(row.weight) ?? undefined;
    const wellness = parseWellnessScore(row.wellness);
    const notes = row.notes || undefined;
    const doseMg = row.dose ? parseFloat(row.dose) : undefined;

    return {
      entryId: row.entryId,
      date: row.date,
      weightLbs,
      wellness,
      symptoms: [...row.symptoms],
      notes,
      doseMg,
      dosePlanned: confirmedAt ? false : row.dosePlanned,
      doseConfirmedAt: confirmedAt ?? row.doseConfirmedAt,
      doseSkipped: row.doseSkipped,
      medication: row.medication as Medication | '',
      shotLocation: row.shotLocation,
      prescriptionId: row.prescriptionId,
    };
  }

  function mergeSavedInputRow(row: HealthInputRow, saved: SavedHealthInputRow): HealthInputRow {
    return {
      ...row,
      entryId: saved.entryId,
      medication: saved.medication ?? '',
      dosePlanned: saved.dosePlanned ?? false,
      doseConfirmedAt: saved.doseConfirmedAt,
      doseSkipped: saved.doseSkipped ?? false,
      prescriptionId: saved.prescriptionId,
    };
  }

  function stripDraftMetadata(row: EditableInputRow): HealthInputRow {
    const { draftId, ...rowWithoutDraftId } = cloneRow(row);
    return rowWithoutDraftId;
  }

  function normalizeWellnessRow<T extends HealthInputRow>(row: T): T {
    if (!row.wellness.trim()) return row;
    return { ...row, wellness: normalizeWellnessScoreInput(row.wellness) };
  }

  // Thin wrapper around the pure helper so call sites don't have to thread
  // `defaultMedication` through every invocation.
  function recalculateDerived(
    rowsToUpdate: HealthInputRow[],
    preserveOrder = false,
    earliestChangedDate?: string,
    scope: RecalcScope = 'full',
  ): HealthInputRow[] {
    return recalculateDerivedPure(rowsToUpdate, {
      defaultMedication,
      preserveOrder,
      earliestChangedDate,
      scope,
    });
  }

  function columnLabel(column: ColumnKey): string {
    return columnLabelsByKey[column] ?? column;
  }

  function resetColumnInteractionState() {
    colDragIndex = null;
    colDragoverIndex = null;
    colKbIndex = null;
  }

  function hideColumn(column: ColumnKey) {
    if (hiddenColumns.has(column)) return;
    hiddenColumns.add(column);
    resetColumnInteractionState();
    persistColumnSettings();
    void announce(`${columnLabel(column)} column hidden.`);
  }

  function showColumn(column: ColumnKey) {
    if (!hiddenColumns.has(column)) return;
    hiddenColumns.delete(column);
    persistColumnSettings();
    void announce(`${columnLabel(column)} column restored.`);
  }

  // For the ≤640px card layout: an unselected cell hides its empty fields so
  // sparse days collapse to just what was logged. `day`/`date` always show.
  function isCellEmpty(row: HealthInputRow, key: ColumnKey): boolean {
    switch (key) {
      case 'day':
      case 'date':
        return false;
      case 'symptoms':
        return row.symptoms.length === 0;
      case 'system':
        return row.systemAmounts.length === 0 && row.system.trim() === '';
      default:
        return (row[key] ?? '').toString().trim() === '';
    }
  }


  function updateCell(index: number, key: ColumnKey, value: string | string[]) {
    const nextRows = [...tableRows];
    const previousDate = nextRows[index].date;
    const nextRow = cloneRow(nextRows[index]);

    if (key === 'symptoms' && Array.isArray(value)) {
      nextRow.symptoms = value;
    } else if (key !== 'symptoms' && typeof value === 'string') {
      nextRow[key] = value as never;
      if (key === 'dose' && !nextRow.medication && Number.isFinite(parseFloat(value)) && parseFloat(value) > 0) {
        nextRow.medication = defaultMedication;
      }
    }

    nextRows[index] = nextRow;
    const earliest = previousDate && nextRow.date && previousDate < nextRow.date ? previousDate : nextRow.date;
    tableRows = recalculateDerived(nextRows, true, earliest || undefined, scopeForColumnKey(key));
  }

  // ── Dose entry: defer the PK recompute ───────────────────────────────────────
  // A dose change recomputes "mg in system" for that date and every later row, so
  // doing it on every keystroke makes typing a dose on an old row block the main
  // thread (badly so on phones). Apply the raw value immediately (cheap), then
  // run the one expensive PK pass on a short debounce and flush it on commit, so
  // the curve still updates promptly but never per-keystroke.
  let doseRecalcTimer: ReturnType<typeof setTimeout> | undefined;
  let flushDosePk: (() => void) | null = null;

  function onDoseInput(index: number, value: string) {
    const nextRows = [...tableRows];
    const nextRow = cloneRow(nextRows[index]);
    nextRow.dose = value;
    if (!nextRow.medication && Number.isFinite(parseFloat(value)) && parseFloat(value) > 0) {
      nextRow.medication = defaultMedication;
    }
    nextRows[index] = nextRow;
    // 'local' scope applies the typed value without touching PK — O(rows) clone,
    // no pharmacokinetics.
    tableRows = recalculateDerived(nextRows, true, undefined, 'local');

    const date = nextRow.date;
    if (doseRecalcTimer) clearTimeout(doseRecalcTimer);
    // Re-resolve the row by identity at flush time: a debounce or commit can fire
    // after the table re-sorted, so the original index may be stale.
    const id = rowIdentity(nextRow);
    flushDosePk = () => {
      if (doseRecalcTimer) clearTimeout(doseRecalcTimer);
      doseRecalcTimer = undefined;
      flushDosePk = null;
      const recalcDate = id
        ? tableRows.find((r) => rowIdentity(r) === id)?.date ?? date
        : date;
      tableRows = recalculateDerived(tableRows.map(cloneRow), true, recalcDate || undefined, 'pk');
    };
    doseRecalcTimer = setTimeout(() => flushDosePk?.(), 180);
  }

  // Run any pending dose PK recompute now (commit paths call this so a save/sort
  // never races a deferred recalc).
  function commitDosePk() {
    flushDosePk?.();
  }

  // Drop a pending dose PK recompute without running it (cancel paths).
  function cancelDosePk() {
    if (doseRecalcTimer) clearTimeout(doseRecalcTimer);
    doseRecalcTimer = undefined;
    flushDosePk = null;
  }

  onDestroy(cancelDosePk);

  function scopeForColumnKey(key: ColumnKey): RecalcScope {
    switch (key) {
      case 'date':
        return 'full';
      case 'weight':
        return 'weight';
      case 'dose':
      case 'medication':
        return 'pk';
      case 'wellness':
      case 'symptoms':
      case 'shotLocation':
      case 'notes':
        return 'local';
      default:
        return 'full';
    }
  }

  function commitWellnessInput(index: number, value: string) {
    const wellness = normalizeWellnessScoreInput(value);
    updateCell(index, 'wellness', wellness);
  }

  function toggleSymptomValue(symptom: string, selectedValues: string[]): string[] {
    return selectedValues.includes(symptom)
      ? selectedValues.filter((v) => v !== symptom)
      : [...selectedValues, symptom];
  }

  async function addOption(kind: ManagedOptionKind) {
    if (kind === 'symptom') {
      const option = newSymptomOption.trim();
      if (!option || $symptomOptions.includes(option)) return;
      newSymptomOption = '';
      const color = newSymptomColor;
      newSymptomColor = '#c8ccd4';
      await addSymptomOption(option, color);
      return;
    }

    const option = newShotLocationOption.trim();
    if (!option || $shotLocationOptions.includes(option)) return;
    newShotLocationOption = '';
    await addShotLocationOption(option);
  }

  function optionKindLabel(kind: ManagedOptionKind): string {
    return kind === 'symptom' ? 'symptom' : 'shot location';
  }

  function countSymptomRecords(records: PersistedHealthRecords, option: string): number {
    const countMatches = (values: string[] | undefined) =>
      (values ?? []).filter((value) => value === option).length;

    return records.entries.reduce((count, entry) => count + countMatches(entry.symptoms), 0);
  }

  function countPersistedOptionRecords(records: PersistedHealthRecords, kind: ManagedOptionKind, option: string): number {
    if (kind === 'shotLocation') {
      return records.entries.filter((entry) => entry.site === option).length;
    }

    return countSymptomRecords(records, option);
  }

  function countCurrentOptionRecords(kind: ManagedOptionKind, option: string): number {
    return rows.reduce((count, row) => {
      if (kind === 'shotLocation') return count + (row.shotLocation === option ? 1 : 0);
      return count + row.symptoms.filter((symptom) => symptom === option).length;
    }, 0);
  }

  async function readPersistedHealthRecords(): Promise<PersistedHealthRecords> {
    return { entries: await getAllEntries() };
  }

  function removeOptionFromRows(
    sourceRows: EditableInputRow[],
    kind: ManagedOptionKind,
    option: string,
  ): EditableInputRow[] {
    return sourceRows.map((row) => {
      if (kind === 'shotLocation') {
        return row.shotLocation === option ? { ...row, shotLocation: '' } : row;
      }

      return row.symptoms.includes(option)
        ? { ...row, symptoms: row.symptoms.filter((symptom) => symptom !== option) }
        : row;
    });
  }

  async function removeOptionDefinition(kind: ManagedOptionKind, option: string) {
    if (kind === 'shotLocation') {
      await removeShotLocationOption(option);
      return;
    }
    await removeSymptomOption(option);
  }

  async function deletePersistedOptionRecords(
    records: PersistedHealthRecords,
    kind: ManagedOptionKind,
    option: string,
  ): Promise<void> {
    if (kind === 'shotLocation') {
      await Promise.all(
        records.entries
          .filter((entry) => entry.site === option)
          .map((entry) => updateEntry(entry.id, { site: '' })),
      );
      return;
    }

    await Promise.all(
      records.entries
        .filter((entry) => (entry.symptoms ?? []).includes(option))
        .map((entry) =>
          updateEntry(entry.id, {
            symptoms: (entry.symptoms ?? []).filter((symptom) => symptom !== option),
          }),
        ),
    );
  }

  async function requestRemoveOption(kind: ManagedOptionKind, option: string) {
    try {
      const records = await readPersistedHealthRecords();
      optionDeleteRequest = { kind, option, count: countPersistedOptionRecords(records, kind, option) };
    } catch (err) {
      console.error(`Failed to count ${optionKindLabel(kind)} records:`, err);
      optionDeleteRequest = { kind, option, count: countCurrentOptionRecords(kind, option) };
    }
  }

  function cancelOptionDelete() {
    optionDeleteRequest = null;
  }

  async function confirmOptionDelete() {
    const request = optionDeleteRequest;
    if (!request) return;
    const { kind, option } = request;
    optionDeleteRequest = null;

    try {
      await deletePersistedOptionRecords(await readPersistedHealthRecords(), kind, option);
      await removeOptionDefinition(kind, option);
      tableRows = removeOptionFromRows(tableRows, kind, option);
      draftBaseTableRows = removeOptionFromRows(draftBaseTableRows, kind, option);
    } catch (err) {
      console.error(`Failed to delete ${optionKindLabel(kind)} records:`, err);
    }
  }

  function removeOption(kind: ManagedOptionKind, option: string) {
    void requestRemoveOption(kind, option);
  }

  function symptomColor(symptom: string): string {
    return resolveSymptomColor(symptom, $symptomColors);
  }

  // Single-mode auto-save commits per cell (see editorKeydown / queueRowSave),
  // so the document-level handler only closes the option-delete dialog and the
  // due-dose confirmation popover on Escape.
  function handleInputCommitKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (optionDeleteRequest !== null) {
      optionDeleteRequest = null;
    } else if (expandedDueId !== null) {
      expandedDueId = null;
    }
  }
</script>

<svelte:document onkeydown={$isMobile ? undefined : handleInputCommitKeydown} onclick={handleDocumentClickForDuePanel} />

<div class="inputs-table-region" bind:this={inputsTableRegion}>
  {#if columnSettingsOpen}
    <section class="column-manager" aria-label="Column visibility and option settings">
      <div class="option-managers">
        <fieldset class="hidden-columns-fieldset">
          <legend class="hidden-columns-legend">
            <span>Hidden columns</span>
            <button
              type="button"
              class="legend-reset-btn"
              aria-label="Reset inputs table columns to defaults"
              title="Reset columns"
              onclick={() => { if (confirm('Reset the Inputs table to its default column order and visibility?')) resetTable(); }}
            >↺</button>
          </legend>
          <div class="option-list">
            {#each hiddenColumnOptions as column (column.key)}
              <button
                type="button"
                class="option-chip option-chip--restore"
                aria-label={`Show ${column.label} column`}
                onclick={() => showColumn(column.key)}
              >
                <span>{column.label}</span>
                <span class="restore-mark" aria-hidden="true">+</span>
              </button>
            {/each}
          </div>
        </fieldset>

        <fieldset>
          <legend>Symptoms options</legend>
          <div class="option-list">
            {#each $symptomOptions as option (option)}
              <span class="option-chip">
                <label class="color-swatch" style="background: {$symptomColors[option] ?? '#c8ccd4'}" aria-label="Change color for {option}">
                  <input
                    type="color"
                    value={$symptomColors[option] ?? '#c8ccd4'}
                    oninput={(e) => { void setSymptomColor(option, e.currentTarget.value); }}
                  />
                </label>
                {option}
                <button type="button" aria-label={`Remove ${option}`} onclick={() => removeOption('symptom', option)}>×</button>
              </span>
            {/each}
          </div>
          <div class="option-actions">
            <label class="color-swatch color-swatch--new" style="background: {newSymptomColor}" aria-label="Choose color for new symptom">
              <input type="color" bind:value={newSymptomColor} />
            </label>
            <input type="text" placeholder="Add symptom" bind:value={newSymptomOption} />
            <button type="button" onclick={() => addOption('symptom')}>Add</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Shot location options</legend>
          <div class="option-list">
            {#each $shotLocationOptions as option (option)}
              <span class="option-chip">
                {option}
                <button
                  type="button"
                  aria-label={`Remove ${option}`}
                  onclick={() => removeOption('shotLocation', option)}
                >×</button>
              </span>
            {/each}
          </div>
          <div class="option-actions">
            <input type="text" placeholder="Add location" bind:value={newShotLocationOption} />
            <button type="button" onclick={() => addOption('shotLocation')}>Add</button>
          </div>
        </fieldset>
      </div>
    </section>
  {/if}

  {#if optionDeleteRequest}
    {@const optionLabel = optionKindLabel(optionDeleteRequest.kind)}
    <div class="confirm-backdrop" role="presentation">
      <div
        class="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-option-title"
        aria-describedby="delete-option-description"
      >
        <h3 id="delete-option-title">Delete {optionLabel} option?</h3>
        <p id="delete-option-description">
          Are you sure you want to delete this {optionLabel} option? It has been recorded
          {optionDeleteRequest.count}
          {optionDeleteRequest.count === 1 ? 'time' : 'times'}. Deleting this {optionLabel} will remove those records permanently.
        </p>
        <div class="confirm-actions">
          <button type="button" class="confirm-yes" onclick={() => void confirmOptionDelete()}>Yes</button>
          <button type="button" class="confirm-cancel" onclick={cancelOptionDelete}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if rowDeleteRequest}
    <ConfirmDialog
      title="Delete this row?"
      message="This permanently removes this day's logged data. This cannot be undone."
      confirmLabel="Delete"
      onConfirm={() => {
        const target = rowDeleteRequest;
        rowDeleteRequest = null;
        mobileEditId = null;
        mobileEditSnapshot = null;
        if (target) void performDeleteRow(target);
      }}
      onCancel={() => (rowDeleteRequest = null)}
    />
  {/if}

  {#snippet systemStack(row: HealthInputRow)}
    {#if row.systemAmounts.length}
      <div class="system-stack" aria-label={row.system.replace(/\n/g, ', ')}>
        {#each row.systemAmounts as amount (amount.medication)}
          <span class="system-entry">
            {formatSystemMg(amount.amountMg)}
            {#if showSystemMedicationLetters}
              <span
                class="system-drug-initial"
                style={`--drug-color:${amount.color}`}
                title={amount.medication}
              >{amount.initial}</span>
            {/if}
          </span>
        {/each}
      </div>
    {:else}
      {row.system}
    {/if}
  {/snippet}

  <div class="table-scroll">
    <table bind:this={tableEl} class="inputs-table inputs-table--editing">
      <colgroup>
        <col class="col-due-action" />
        {#each activeColumns as column (column.key)}
          <col class={`col-${column.key}`} class:stretch-column={column.key === stretchColumnKey} />
        {/each}
      </colgroup>
      <thead>
        <tr>
          <th class="due-action-header" aria-hidden="true"></th>
          {#each activeColumns as column, colIndex (column.key)}
            <th
              class={column.key}
              class:col-dragging={columnSettingsOpen && (colDragIndex === colIndex || colKbIndex === colIndex)}
              class:col-indicator-left={columnSettingsOpen && colIndicator?.col === colIndex && colIndicator?.side === 'left'}
              class:col-indicator-right={columnSettingsOpen && colIndicator?.col === colIndex && colIndicator?.side === 'right'}
              draggable={columnSettingsOpen}
              ondragstart={(e) => { e.stopPropagation(); colDragIndex = colIndex; }}
              ondragover={(e) => { e.preventDefault(); e.stopPropagation(); colDragoverIndex = colIndex; }}
              ondragleave={() => { if (colDragoverIndex === colIndex) colDragoverIndex = null; }}
              ondrop={(e) => { e.stopPropagation(); if (colDragIndex !== null) reorderColumns(colDragIndex, colIndex); colDragIndex = null; colDragoverIndex = null; }}
              ondragend={() => { colDragIndex = null; colDragoverIndex = null; }}
            >
              {#if columnSettingsOpen}
                <div class="th-edit">
                  <button
                    type="button"
                    class="drag-handle"
                    id="col-handle-{column.key}"
                    aria-roledescription="Drag handle"
                    aria-label="Reorder {column.label} column"
                    aria-pressed={colKbIndex === colIndex}
                    ondragstart={(e) => e.preventDefault()}
                    onkeydown={$isMobile ? undefined : (e) => colKeydown(e, colIndex)}
                  >⠿</button>
                  <span class="th-label">{column.label}</span>
                  <button
                    type="button"
                    class="column-remove-btn"
                    aria-label={`Remove ${column.label} column`}
                    onclick={() => hideColumn(column.key)}
                  >×</button>
                </div>
              {:else}
                {column.label}
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        <!-- The due-confirm `!` badge + its Taken/Skip panel. Shared so it can
             render in the card gutter on desktop and inline next to the date on
             mobile, with identical behaviour. -->
        {#snippet dueBadge(rowIndex: number, row: EditableInputRow, isExpanded: boolean)}
          <div class="due-action-wrap">
            <button
              type="button"
              class="due-action-btn"
              class:expanded={isExpanded}
              class:selected={isDueSelected(rowIndex)}
              data-due-row={rowIndex}
              tabindex={$isMobile ? undefined : (isDueSelected(rowIndex) ? 0 : -1)}
              aria-label="Confirm whether this dose was taken"
              aria-expanded={isExpanded}
              title="Confirm whether this dose was taken"
              onclick={() => activateDueFromClick(rowIndex, row)}
              onkeydown={$isMobile ? undefined : dueButtonKeydown}
            >!</button>
            {#if isExpanded}
              <div class="due-action-panel" role="group" aria-label="Confirm planned dose" data-due-row={rowIndex}>
                <button
                  type="button"
                  class="due-action-confirm"
                  class:selected={duePanelNav === 'taken' && isDueSelected(rowIndex)}
                  onclick={() => confirmDue(row, 'taken')}
                  onkeydown={$isMobile ? undefined : (e) => duePanelKeydown(e, row)}
                >Taken</button>
                <button
                  type="button"
                  class="due-action-skip"
                  class:selected={duePanelNav === 'skipped' && isDueSelected(rowIndex)}
                  onclick={() => confirmDue(row, 'skipped')}
                  onkeydown={$isMobile ? undefined : (e) => duePanelKeydown(e, row)}
                >Skip</button>
              </div>
            {/if}
          </div>
        {/snippet}
        {#if topSpacerHeight > 0}
          <tr aria-hidden="true" class="virtual-spacer">
            <td colspan={activeColumns.length + 1} style={`height:${topSpacerHeight}px`}></td>
          </tr>
        {/if}
        {#each visibleRows as row, sliceIndex (rowKey(row, firstVisibleIndex + sliceIndex))}
          {@const rowIndex = firstVisibleIndex + sliceIndex}
          {@const dueConfirm = isDueConfirmation(row)}
          {@const isExpanded = !!row.entryId && expandedDueId === row.entryId}
          <tr
            class:row-alt={rowIndex % 2 === 1}
            class:new-row={isDraftRow(row)}
            class:row-skipped={row.doseSkipped}
            class:row-needs-medication={rowMissingMedication(row)}
            class:mobile-card-editing={isRowMobileEditing(row)}
          >
            <td class="due-action-cell">
              {#if columnSettingsOpen}
                <button
                  type="button"
                  class="row-delete-btn"
                  aria-label={`Delete row for ${row.date}`}
                  title="Delete row"
                  onclick={() => deleteRow(row)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M2.6 4.2h10.8M6.4 4.2V2.9a.7.7 0 0 1 .7-.7h1.8a.7.7 0 0 1 .7.7v1.3M4.6 4.2l.6 8.5a1.1 1.1 0 0 0 1.1 1h3.4a1.1 1.1 0 0 0 1.1-1l.6-8.5M6.7 6.6v4.6M9.3 6.6v4.6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
              {:else if dueConfirm && !$isMobile}
                {@render dueBadge(rowIndex, row, isExpanded)}
              {/if}
            </td>
            {#each activeColumns as column, colIndex (column.key)}
              {@const rowEditing = isRowMobileEditing(row)}
              <!-- On mobile a cell is "editing" when its card is open (all text
                   fields at once); on desktop it's the two-state grid selection. -->
              {@const editingCell = $isMobile ? (rowEditing && isTextColumn(column.key)) : isCellEditing(rowIndex, colIndex)}
              <!-- On mobile, pickers render their interactive control only inside
                   the open card; otherwise a static value (read-only). -->
              {@const showPicker = !$isMobile || rowEditing}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <td
                class={column.key}
                data-cell={`${rowIndex}-${colIndex}`}
                data-label={column.label}
                tabindex={$isMobile ? undefined : ((selRow === null ? rowIndex === 0 && colIndex === 0 : isSelected(rowIndex, colIndex)) ? 0 : -1)}
                class:cell-selected={!$isMobile && isRingSelected(rowIndex, colIndex)}
                class:cell-editing={editingCell && !$isMobile}
                class:cell-readonly={READONLY_COLS.has(column.key)}
                class:empty-cell={isCellEmpty(row, column.key) && !rowEditing && !isSelected(rowIndex, colIndex)}
                class:col-indicator-left={columnSettingsOpen && colIndicator?.col === colIndex && colIndicator?.side === 'left'}
                class:col-indicator-right={columnSettingsOpen && colIndicator?.col === colIndex && colIndicator?.side === 'right'}
                onclick={$isMobile ? undefined : () => selectCell(rowIndex, colIndex, true)}
                onkeydown={$isMobile ? undefined : (e) => cellKeydown(e, rowIndex, colIndex)}
                onfocusin={$isMobile ? undefined : () => {
                  // Tabbed into the grid with nothing active yet → adopt this
                  // cell so the selection ring shows and arrows work from here.
                  if (selRow === null) {
                    selRow = rowIndex;
                    selCol = colIndex;
                  }
                }}
              >
                {#if column.key === 'system'}
                  {@render systemStack(row)}
                {:else if column.key === 'loss'}
                  <span class="cell-static">{displayWeight(row.loss, $weightUnit)}</span>
                {:else if column.key === 'day'}
                  <span class="cell-static">{row.day}</span>
                {:else if column.key === 'symptoms'}
                  {#if showPicker}
                    <MultiPicker
                      values={row.symptoms}
                      options={$symptomOptions}
                      optionColor={symptomColor}
                      forceOpen={isCellEditing(rowIndex, colIndex)}
                      onRequestClose={() => exitToCell(rowIndex, colIndex)}
                      onToggle={(symptom) => {
                        updateCell(rowIndex, 'symptoms', toggleSymptomValue(symptom, row.symptoms));
                        queueRowSave(rowIndex);
                      }}
                      ariaLabel={isDraftRow(row) ? 'Symptoms for new row' : `Symptoms for row ${rowIndex + 1}`}
                    />
                  {:else}
                    <span class="cell-static">{row.symptoms.join(', ')}</span>
                  {/if}
                {:else if column.key === 'shotLocation'}
                  {#if showPicker}
                    <CustomPicker
                      value={row.shotLocation}
                      options={optionsWithCurrent(shotLocationSelectOptions, row.shotLocation)}
                      forceOpen={isCellEditing(rowIndex, colIndex)}
                      onRequestClose={() => exitToCell(rowIndex, colIndex)}
                      onSelect={(value) => { updateCell(rowIndex, 'shotLocation', value); queueRowSave(rowIndex); }}
                      ariaLabel={isDraftRow(row) ? 'Shot location for new dose' : 'Shot location'}
                    />
                  {:else}
                    <span class="cell-static">{row.shotLocation}</span>
                  {/if}
                {:else if column.key === 'dose'}
                  <div class="dose-entry">
                    {#if showPicker}
                    <DoseVialPicker
                      prescriptionId={row.prescriptionId}
                      autoVialDbId={row.entryId ? $vialByEntryId.get(row.entryId) : undefined}
                      medication={row.medication}
                      vials={vialOptions}
                      drugOptions={medicationOptions}
                      forceOpen={!$isMobile && editing && isVialSelected(rowIndex)}
                      vialSelected={!$isMobile && isVialSelected(rowIndex)}
                      onActivate={$isMobile ? undefined : () => setVialSelection(rowIndex, true)}
                      onRequestClose={$isMobile ? undefined : () => exitToVial(rowIndex)}
                      ariaLabel={isDraftRow(row) ? 'Vial or drug for new dose' : 'Vial or drug for this dose'}
                      onPickVial={(dbId, type) => pickVial(rowIndex, dbId, type)}
                      onPickDrug={(med) => pickDrug(rowIndex, med)}
                      onClear={() => clearVialOverride(rowIndex)}
                    />
                    {/if}
                    <!-- On mobile the dose editor must never be gated by `selVial`
                         (a desktop grid concept) — clicking the vial chip there
                         opens the picker without engaging the grid, so selVial
                         stays put and the field would otherwise vanish. -->
                    {#if editingCell && (!selVial || $isMobile)}
                      <input
                        class="cell-input dose-input"
                        type="text"
                        size="1"
                        value={row.dose}
                        oninput={(event) => onDoseInput(rowIndex, event.currentTarget.value)}
                        onblur={() => editorBlur(row)}
                        onkeydown={$isMobile ? undefined : editorKeydown}
                        placeholder={isDraftRow(row) ? 'New dose' : undefined}
                      />
                    {:else}
                      <span class="cell-static dose-number"
                        >{row.dose ? fmtNum(parseFloat(row.dose), doseDecimals) : ''}</span
                      >
                    {/if}
                    {#if rowMissingMedication(row)}
                      <span
                        class="medication-warning-icon"
                        title="No medication set — this dose is not shown on the graph."
                        aria-label="No medication set — this dose is not shown on the graph."
                      >⚠</span>
                    {/if}
                  </div>
                {:else if column.key === 'date'}
                  {#if editingCell}
                    <DateInput
                      value={row.date}
                      onchange={(v) => updateCell(rowIndex, 'date', v)}
                      onkeydown={$isMobile ? undefined : editorKeydown}
                      onblur={() => editorBlur(row)}
                    />
                  {:else}
                    <span class="cell-static">{formatLocaleDate(row.date)}</span>
                  {/if}
                  <!-- Mobile only: the due-confirm `!` sits inline, just to the
                       right of the date and vertically centered with it. On
                       desktop the same badge floats in the card gutter instead. -->
                  {#if $isMobile && dueConfirm && !rowEditing}
                    {@render dueBadge(rowIndex, row, isExpanded)}
                  {/if}
                  <!-- Mobile-only per-card controls live in the card's header (date)
                       row: the pencil (read) ↔ Save/Cancel/Delete (edit). Hidden on
                       desktop via .card-header-actions{display:none}. -->
                  <span class="card-header-actions">
                    {#if isRowMobileEditing(row)}
                      <button type="button" class="card-action-btn card-save" aria-label="Save" title="Save" onclick={() => saveMobileEdit(row)}><SaveIcon size="1.1rem" /></button>
                      <button type="button" class="card-action-btn card-delete" aria-label="Delete" title="Delete" onclick={() => (rowDeleteRequest = row)}><TrashIcon size="1.15rem" /></button>
                      <button type="button" class="card-action-btn card-cancel" aria-label="Cancel" title="Cancel" onclick={() => cancelMobileEdit(row)}><CloseIcon size="1.1rem" /></button>
                    {:else}
                      <EditPencil ariaLabel={`Edit entry for ${row.date}`} onclick={() => startMobileEdit(row)} />
                    {/if}
                  </span>
                {:else if column.key === 'weight'}
                  {#if editingCell}
                    <input
                      class="cell-input"
                      type="text"
                      value={weightDrafts.has(rowKey(row, rowIndex)) ? (weightDrafts.get(rowKey(row, rowIndex)) ?? '') : (row.weight ? fmtNum(lbsToDisplayNum(row.weight, $weightUnit), weightDecimals) : '')}
                      oninput={(event) => { weightDrafts.set(rowKey(row, rowIndex), event.currentTarget.value); }}
                      onblur={() => editorBlur(row)}
                      onkeydown={$isMobile ? undefined : editorKeydown}
                      placeholder={isDraftRow(row) ? `Weight (${$weightUnit})` : undefined}
                    />
                  {:else}
                    <span class="cell-static">{row.weight ? fmtNum(lbsToDisplayNum(row.weight, $weightUnit), weightDecimals) : ''}</span>
                  {/if}
                {:else if column.key === 'wellness'}
                  {#if editingCell}
                    <input
                      class="cell-input"
                      type="number"
                      value={row.wellness}
                      min={WELLNESS_SCORE_MIN}
                      max={WELLNESS_SCORE_MAX}
                      step="1"
                      title={`Wellness score ${WELLNESS_SCORE_MIN}-${WELLNESS_SCORE_MAX}`}
                      oninput={(event) => updateCell(rowIndex, 'wellness', event.currentTarget.value)}
                      onblur={(event) => { commitWellnessInput(rowIndex, event.currentTarget.value); editorBlur(row); }}
                      onkeydown={$isMobile ? undefined : editorKeydown}
                      placeholder={`${WELLNESS_SCORE_MIN}-${WELLNESS_SCORE_MAX}`}
                    />
                  {:else}
                    <span class="cell-static">{row.wellness ? normalizeWellnessScoreInput(row.wellness) : ''}</span>
                  {/if}
                {:else if column.key === 'notes'}
                  {#if editingCell}
                    <textarea
                      class="cell-input notes-input"
                      value={row.notes}
                      oninput={(event) => updateCell(rowIndex, 'notes', event.currentTarget.value)}
                      onblur={() => editorBlur(row)}
                      onkeydown={$isMobile ? undefined : editorKeydown}
                      placeholder={isDraftRow(row) ? 'New notes (Shift+Enter for a new line)' : undefined}
                    ></textarea>
                  {:else}
                    <span class="cell-static">{row.notes}</span>
                  {/if}
                {:else}
                  {#if editingCell}
                    <input
                      class="cell-input"
                      type="text"
                      value={row[column.key]}
                      oninput={(event) => updateCell(rowIndex, column.key, event.currentTarget.value)}
                      onblur={() => editorBlur(row)}
                      onkeydown={$isMobile ? undefined : editorKeydown}
                      placeholder={isDraftRow(row) ? `New ${column.label.toLowerCase()}` : undefined}
                    />
                  {:else}
                    <span class="cell-static">{row[column.key]}</span>
                  {/if}
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
        {#if bottomSpacerHeight > 0}
          <tr aria-hidden="true" class="virtual-spacer">
            <td colspan={activeColumns.length + 1} style={`height:${bottomSpacerHeight}px`}></td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>

  <div role="status" aria-live="polite" aria-atomic="true" class="sr-only">{announcement}</div>
</div>

<style>
  /* Containing block for the due-action badge. Because the badge is positioned
     against THIS element (an ancestor of the horizontally-scrolling
     `.table-scroll`), the scroll container's overflow never clips it — so the
     badge can sit out in the card gutter, on top of everything, while the table
     still clips exactly at its own edge (no boundary change, no scroll leak). */
  .inputs-table-region {
    position: relative;
  }

  .column-manager {
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, white 60%);
    border-radius: 12px;
    padding: 0.7rem;
    margin-bottom: 0.75rem;
    /* Solid fill: this panel sits above the chip strip (via .inputs-panel's
     * z-index), so a transparent background would let the tab skirts show
     * through it. Opaque --surface paints them out cleanly. */
    background: var(--surface);
  }

  .th-edit {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .th-label {
    line-height: 1.08;
  }

  th[draggable='true'] {
    cursor: grab;
  }

  .drag-handle {
    font-size: 1.1rem;
    color: color-mix(in oklab, var(--cardBorder) 55%, #aaa 45%);
    cursor: grab;
    user-select: none;
    line-height: 1;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font-family: inherit;
  }

  .drag-handle:focus-visible {
    outline: 2px solid var(--cardBorder);
    outline-offset: 2px;
    border-radius: 3px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  th.col-dragging {
    opacity: 0.35;
  }

  th.col-indicator-left,
  td.col-indicator-left {
    border-left: 3px solid var(--cardBorder) !important;
  }

  th.col-indicator-right,
  td.col-indicator-right {
    border-right: 3px solid var(--cardBorder) !important;
  }

  .option-managers {
    margin-top: 0.8rem;
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    align-items: stretch;
  }

  fieldset {
    border: 1px solid color-mix(in oklab, var(--cardBorder) 30%, white 70%);
    border-radius: 10px;
    padding: 0.55rem;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  legend {
    padding-inline: 0.25rem;
    font-weight: 600;
  }

  .hidden-columns-legend {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .option-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.5rem;
  }

  .option-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, white 60%);
    border-radius: 999px;
    padding: 0.15rem 0.45rem;
    font-size: 0.9rem;
  }

  button.option-chip {
    background: color-mix(in oklab, var(--surface) 78%, transparent);
    color: inherit;
    cursor: pointer;
    font: inherit;
  }

  button.option-chip:hover {
    background: color-mix(in oklab, var(--surface) 96%, transparent);
  }

  .option-chip--restore {
    padding-right: 0.35rem;
  }

  .legend-reset-btn {
    border: 0;
    border-radius: 7px;
    width: 1.45rem;
    height: 1.45rem;
    padding: 0;
    background: color-mix(in oklab, var(--headerBg) 88%, transparent);
    color: var(--headerText);
    font-size: 0.95rem;
    font-weight: 800;
    line-height: 0;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cardBorder) 16%, transparent 84%);
  }

  .legend-reset-btn:hover {
    background: color-mix(in oklab, var(--headerBg) 76%, white 24%);
  }

  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgba(17, 24, 39, 0.38);
  }

  .confirm-dialog {
    width: min(100%, 26rem);
    border: 1px solid color-mix(in oklab, var(--cardBorder) 48%, white 52%);
    border-radius: 12px;
    padding: 1rem;
    background: color-mix(in oklab, var(--surface) 92%, transparent);
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.22);
  }

  .confirm-dialog h3 {
    margin: 0 0 0.45rem;
    font-size: 1.05rem;
  }

  .confirm-dialog p {
    margin: 0;
    line-height: 1.38;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.45rem;
    margin-top: 0.9rem;
  }

  .confirm-actions button {
    border-radius: 8px;
    padding: 0.48rem 0.7rem;
    font-weight: 800;
    cursor: pointer;
  }

  .confirm-yes {
    border: 0;
    background: var(--danger);
    color: white;
  }

  .confirm-cancel {
    border: 1.5px solid color-mix(in oklab, var(--cardBorder) 35%, #d4d4d4 65%);
    background: color-mix(in oklab, var(--surface) 82%, transparent);
    color: var(--text);
  }

  .restore-mark {
    color: var(--cardBorder);
    font-size: 1rem;
    font-weight: 800;
    line-height: 1;
  }

  .column-remove-btn {
    border: 0;
    border-radius: 8px;
    width: 1.45rem;
    height: 1.45rem;
    padding: 0;
    background: rgba(255, 255, 255, 0.2);
    color: white;
    font-size: 1.05rem;
    font-weight: 800;
    line-height: 0;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }

  .column-remove-btn:hover {
    background: rgba(255, 255, 255, 0.34);
  }

  .option-chip button {
    border: 0;
    background: transparent;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }

  .option-actions {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.4rem;
    align-items: center;
  }

  .color-swatch {
    position: relative;
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 50%;
    flex-shrink: 0;
    cursor: pointer;
    border: 1px solid rgba(0, 0, 0, 0.18);
    display: inline-block;
  }

  .color-swatch--new {
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
  }

  .color-swatch input[type='color'] {
    position: absolute;
    opacity: 0;
    width: 100%;
    height: 100%;
    top: 0;
    left: 0;
    cursor: pointer;
    padding: 0;
    border: none;
  }

  .table-scroll {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
  }

  .inputs-table {
    width: 100%;
    /* Grid lines (table outline + between cells) tinted the same as the header
       cell background. */
    --inputs-grid: color-mix(in oklab, var(--headerBg) 60%, white 40%);
    border-collapse: collapse;
    border: 1px solid var(--inputs-grid);
  }

/*  .inputs-table th:not(.due-action-header),
  .inputs-table td:not(.due-action-cell) {
    border: 1px solid var(--inputs-grid);
  }*/

  .inputs-table tr.virtual-spacer td {
    border: 0;
  }

  .inputs-table col {
    width: 1px;
  }

  .inputs-table col.stretch-column {
    width: 100%;
  }

  .inputs-table th {
    white-space: nowrap;
    background: color-mix(in oklab, var(--headerBg) 60%, white 40%);
    color: var(--headerText);
    text-align: center;
  }

  .inputs-table td {
    font-size: 1.02rem;
    vertical-align: middle;
    text-align: center;
    padding: 0.2rem 0.3rem;
    /* Positioning context so an editor can overlay the cell (see input.cell-input
       below) without affecting column sizing. */
    position: relative;
  }

  /* Single-mode spreadsheet cells: a focusable cell shows a selection ring; its
     editor swaps in at identical metrics (borderless, transparent) so clicking
     a cell to edit never changes its size. */
  /* The cell ring is driven by real DOM :focus, so it shows only while the cell
     itself is focused and vanishes the moment focus leaves the grid — there's
     never more than one selector on the page. When focus moves into an inner
     control (editor/open dropdown), the td isn't :focus, so the cell ring steps
     aside and that control's own focus ring / the edit ring shows instead. */
  /* Select mode: a flat accent ring. */
  .inputs-table td.cell-selected:focus {
    box-shadow: inset 0 0 0 2px var(--accent);
    border-radius: 4px;
  }

  /* Edit mode: a distinctly darker border plus a strong inner shadow, so it's
     unmistakable at a glance that the cell is being edited (vs merely selected,
     which is the flat accent ring above). */
  .inputs-table td.cell-editing:not(.symptoms):not(.shotLocation) {
    box-shadow:
      inset 0 0 0 2.5px color-mix(in oklab, var(--accent) 30%, var(--text) 70%),
      inset 0 0 18px 4px color-mix(in oklab, var(--accent) 60%, transparent);
    border-radius: 4px;
  }

  .inputs-table td:focus,
  .inputs-table td:focus-visible {
    outline: none;
  }

  .cell-static {
    display: block;
    min-height: 1.3em;
    white-space: pre-wrap;
  }

  /* The text/number editor overlays the cell instead of sitting in flow, so its
     intrinsic width (a bare <input> defaults to ~20ch) can't inflate the column —
     the cell keeps the static-text width and the editor just fills it. Same trick
     as .notes-input. (Excludes the dose cell, whose input shares a flex row with
     the vial picker; that one is constrained separately below.) Reverted to
     in-flow on mobile (see the ≤640px block). */
  .inputs-table :global(input.cell-input:not(.dose-input)) {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    border: 0;
    border-radius: 0;
    padding: 0.2rem 0.3rem;
    background: transparent;
    font: inherit;
    color: inherit;
    text-align: inherit;
    outline: none;
  }

  /* Notes edit in place as a wrapping textarea that fills the cell's full
     height — so on a tall row (e.g. many symptoms) the editor uses all the
     vertical space, not just two lines. Same look as the static cell. */
  /* The cell already has the row's full height (a tall sibling like symptoms
     stretches every cell). Absolutely fill that box so the textarea uses it all,
     dodging the unreliable table-cell percentage-height resolution. */
  .inputs-table td.notes.cell-editing {
    position: relative;
  }

  .notes-input {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    border: 0;
    border-radius: 0;
    margin: 0;
    padding: 0.2rem 0.3rem;
    background: transparent;
    font: inherit;
    color: inherit;
    line-height: inherit;
    resize: none;
    outline: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-y: auto;
  }

  .inputs-table th.day,
  .inputs-table td.day,
  .inputs-table th.medication,
  .inputs-table td.medication {
    text-align: left;
  }

  .inputs-table th.system,
  .inputs-table td.system,
  .inputs-table td.dose,
  .inputs-table th.weight,
  .inputs-table td.weight,
  .inputs-table th.wellness,
  .inputs-table td.wellness,
  .inputs-table th.loss,
  .inputs-table td.loss {
    text-align: right;
  }

  .inputs-table th.notes,
  .inputs-table td.notes {
    min-width: 16rem;
    text-align: left;
  }

  .inputs-table th.symptoms,
  .inputs-table td.symptoms {
    text-align: left;
  }

  .inputs-table th.date,
  .inputs-table td.date {
    min-width: 7.5rem;
  }

  .inputs-table td.notes input {
    min-width: 16rem;
  }

  .inputs-table--editing th.shotLocation,
  .inputs-table--editing td.shotLocation {
    min-width: 8rem;
  }

  .inputs-table :global(input:not([type='checkbox'])),
  .option-actions input,
  .option-actions button {
    font: inherit;
  }

  .inputs-table :global(input:not([type='checkbox'])),
  .option-actions input {
    width: 100%;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, white 60%);
    border-radius: 8px;
    padding: 0.22rem 0.35rem;
    background: var(--surface);
  }

  .inputs-table tbody tr.row-alt {
    background: var(--rowAlt);
  }

  .system-stack {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.12rem;
    line-height: 1.12;
  }

  .system-entry {
    white-space: nowrap;
  }

  .system-drug-initial {
    display: inline-grid;
    place-items: center;
    min-width: 1.15em;
    height: 1.15em;
    margin-left: 0.22rem;
    border-radius: 999px;
    background: var(--drug-color);
    color: white;
    font-size: 0.72em;
    font-weight: 800;
    line-height: 1;
    vertical-align: 0.08em;
  }

  /* Number + compact vial/drug chip on one line; the chip stays ~1.5rem so the
     dose column never grows. */
  .dose-entry {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    min-width: 0;
  }

  .dose-entry .dose-number {
    flex: 1 1 auto;
    text-align: right;
    min-width: 0;
  }

  .dose-entry .dose-input {
    /* basis 0 + size=1 (in markup) keep the editor from contributing its ~20ch
       default width to the dose column; it grows to fill the slot via flex. */
    flex: 1 1 0;
    text-align: right;
    min-width: 0;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    padding: 0;
    font: inherit;
    color: inherit;
    outline: none;
  }

  .pill {
    border-radius: 999px;
    padding: 0.14rem 0.5rem;
    font-size: 0.95rem;
    color: var(--text);
    white-space: nowrap;
  }

  .new-row {
    border-top: 1px solid color-mix(in oklab, var(--cardBorder) 30%, white 70%);
  }

  .virtual-spacer td {
    padding: 0;
    border: 0;
    background: transparent;
  }

  .row-needs-medication td:first-of-type {
    box-shadow: inset 3px 0 0 var(--danger);
  }

  .medication-warning-icon {
    margin-left: 0.3rem;
    color: var(--danger);
    cursor: help;
  }

  .inputs-table col.col-due-action {
    width: 1.7rem;
  }

  .inputs-table th.due-action-header {
    background: transparent;
    border: 0;
    padding: 0;
  }

  .inputs-table td.due-action-cell {
    padding: 0;
    text-align: center;
    vertical-align: middle;
    overflow: visible;
    position: relative;
  }

  .due-action-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .due-action-btn {
    border: 1px solid var(--warning);
    background: color-mix(in oklab, var(--headerBg) 18%, white 82%);
    color: var(--warning);
    font-weight: 800;
    font-size: 0.9rem;
    line-height: 1;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 999px;
    padding: 0;
    cursor: pointer;
    display: inline-grid;
    place-items: center;
    opacity: 1;
  }

  .due-action-btn:hover,
  .due-action-btn.expanded {
    background: var(--warning);
    color: color-mix(in oklab, var(--headerBg) 18%, white 82%);
    border: 1px solid color-mix(in oklab, var(--headerBg) 18%, white 82%);
  }

  /* Grid selector resting on the badge. */
  .due-action-btn.selected {
    box-shadow:
      0 0 0 2px var(--surface),
      0 0 0 4px var(--accent);
    outline: none;
  }

  .due-action-panel {
    position: absolute;
    left: 1.7rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 4;
    display: inline-flex;
    gap: 0.3rem;
    padding: 0.25rem 0.35rem;
    background: var(--surface);
    border: 1px solid var(--cardBorder);
    border-radius: 10px;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18);
    white-space: nowrap;
  }

  .due-action-confirm,
  .due-action-skip {
    border-radius: 8px;
    padding: 0.3rem 0.65rem;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .due-action-confirm {
    background: var(--headerBg);
    color: var(--headerText);
    border-color: var(--cardBorder);
  }

  .due-action-skip {
    background: var(--surface);
    color: var(--danger);
    border-color: color-mix(in oklab, var(--danger) 50%, white 50%);
  }

  .due-action-skip:hover {
    background: color-mix(in oklab, var(--danger) 10%, transparent 90%);
  }

  /* Keyboard selector resting on a panel button. */
  .due-action-confirm.selected,
  .due-action-skip.selected {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* ── Desktop (≥641px): the due-confirm badge sits in the card gutter ──
   * On mobile each row is a card and this button floats in the card corner (see
   * the ≤640px block); the dedicated column + zero-width header exist only to
   * support that layout. On desktop the table is flat, so the column reserves no
   * width and the badge is lifted out into the card gutter, on top of
   * everything. It's positioned against `.inputs-table-region` (an ancestor of
   * `.table-scroll`), so the scroll container's overflow never clips it — and
   * because `.table-scroll` itself is left untouched, the table still clips at
   * its own edge and never leaks past the card when scrolled horizontally. */
  @media (min-width: 641px) {
    .inputs-table col.col-due-action {
      width: 0;
    }

    .inputs-table th.due-action-header,
    .inputs-table td.due-action-cell {
      width: 0;
      padding: 0;
      /* static so the badge's containing block is `.inputs-table-region`, not
       * this cell — that's what lets it escape the scroll clip. */
      position: static;
      overflow: visible;
    }

    .inputs-table td.due-action-cell .due-action-wrap {
      position: absolute;
      /* `top` is set in px by positionDueBadges() (measured row center, relative
       * to .inputs-table-region); the transform centers on it and nudges the
       * badge left into the gutter. left:auto keeps the static horizontal spot. */
      transform: translate(-1.6rem, -50%);
      z-index: 30;
    }
  }

  tbody tr.row-skipped td:not(.due-action-cell) {
    color: var(--danger);
    text-decoration: line-through;
    text-decoration-color: var(--danger);
  }

  tbody tr.row-skipped .pill {
    opacity: 0.55;
  }

  /* Gutter trash-can shown for every row while the gear (settings) is open. */
  .row-delete-btn {
    border: 0;
    border-radius: 8px;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    background: color-mix(in oklab, var(--danger) 12%, transparent 88%);
    color: var(--danger);
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }

  .row-delete-btn svg {
    width: 1rem;
    height: 1rem;
  }

  .row-delete-btn:hover {
    background: color-mix(in oklab, var(--danger) 25%, transparent 75%);
  }

  /* Per-card controls live in the card header (date) row on mobile only; the
     desktop spreadsheet never shows them. */
  .card-header-actions {
    display: none;
  }

  @media (max-width: 1280px) {
    .inputs-table td {
      font-size: 0.95rem;
    }
  }

  /* ── ≤640px: the inputs table becomes one card per day ──
   * Same responsive-table CSS trick used in MedicationTab: keep the single
   * <table> (so editing / virtualization / column logic are untouched) and
   * re-flow it to blocks. `data-label` on each <td> supplies the field name via
   * ::before; `.empty-cell` (set only on read-only rows) hides unlogged fields
   * so sparse days collapse. The per-row height windowing already drops its
   * cached heights on the width change, so it re-measures these taller cards. */
  @media (max-width: 640px) {
    .table-scroll {
      overflow-x: visible;
      max-width: none;
    }

    .inputs-table {
      min-width: 0;
    }

    /* The desktop grid lines don't apply to the card layout — each row is its
       own bordered card instead. */
    .inputs-table,
    .inputs-table th,
    .inputs-table td {
      border: 0;
    }

    .inputs-table,
    .inputs-table tbody {
      display: block;
    }

    /* Column widths are meaningless once cells are block-level. */
    .inputs-table colgroup {
      display: none;
    }

    /* Keep the header in the DOM for screen readers, hide it visually. */
    .inputs-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .inputs-table tbody tr {
      /* Flex column (not block) so cells can be re-ordered: the date becomes the
       * card's top line via `order`, which frees its empty right side for the
       * due-confirm button (see td.date / td.due-action-cell below). */
      display: flex;
      flex-direction: column;
      position: relative;
      border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, #f0f0f0 60%);
      border-radius: 12px;
      padding: 0.4rem 0.7rem 0.55rem;
      margin-bottom: 0.6rem;
      /* Opaque base: the row tint is semi-transparent (rgba ~0.14), so paint it
       * over --surface like MedicationTab does, ready for a chip-strip skirt. */
      background: var(--surface);
    }

    /* No zebra striping in the card layout — every card is the same surface. */
    .inputs-table tbody tr.row-alt {
      background: var(--surface);
    }

    .inputs-table tbody tr:last-child {
      margin-bottom: 0;
    }

    /* Virtualization spacers stay pure height — no card chrome, no label. */
    .inputs-table tbody tr.virtual-spacer {
      display: block;
      border: 0;
      padding: 0;
      margin: 0;
      background: none;
    }

    .inputs-table tbody tr.virtual-spacer td {
      display: block;
    }

    .inputs-table tbody tr.virtual-spacer td::before {
      content: none;
    }

    .inputs-table td {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      text-align: right;
      border: none;
      border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 22%, transparent);
      padding: 0.2rem 0.0rem;
      overflow: visible;
      white-space: normal;
    }

    .inputs-table td:last-child {
      border-bottom: none;
    }

    .inputs-table td::before {
      content: attr(data-label);
      flex: 0 0 auto;
      text-align: left;
      font-weight: 600;
      font-variant: small-caps;
      color: color-mix(in oklab, currentColor 60%, transparent);
    }

    /* Sparse days collapse: read-only rows hide their unlogged fields. */
    .inputs-table td.empty-cell {
      display: none;
    }

    /* The date is the card's header row: the date/value on the left, the per-card
     * controls (pencil, or Save/Cancel/Delete) on the right. order:-1 lifts it to
     * the top of the card. */
    .inputs-table td.date {
      order: -1;
      /* date value + due `!` group on the left; the action cluster is pushed to
         the far right via margin-left:auto below. */
      justify-content: flex-start;
      align-items: center;
      flex-wrap: wrap;
      column-gap: 0.5rem;
      border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 32%, transparent);
      padding-right: 0.25rem;
      padding-bottom: 0.6rem;
      margin-bottom: 0.15rem;
      font-weight: 700;
      font-size: 1.05rem;
    }

    .inputs-table td.date::before {
      content: none;
    }

    /* The pencil / Save·Cancel·Delete cluster on the right of the header row. */
    .card-header-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.4rem;
      /* Hug the right edge so the due `!` can sit beside the date on the left. */
      margin-left: auto;
    }

    /* In edit mode the date editor keeps a sensible width; the compact icon
       actions (Save / Cancel / Delete) sit beside it on the same row. */
    .inputs-table tr.mobile-card-editing td.date :global(input) {
      flex: 1 1 7rem;
    }

    /* The dedicated due-action gutter cell is unused on mobile — the `!` badge is
       rendered inline in the date header instead (see the date cell). Collapse
       the empty cell entirely. */
    .inputs-table td.due-action-cell {
      display: none;
    }

    /* The desktop overlay (position:absolute) doesn't apply to the card layout —
       here the editor is an in-flow flex item beside its label. */
    .inputs-table :global(input.cell-input:not(.dose-input)) {
      position: static;
    }

    /* Inputs/pickers share the row with their label rather than filling it. */
    .inputs-table td :global(input),
    .inputs-table td :global(select) {
      width: auto;
      flex: 1 1 0;
      min-width: 0;
      max-width: 62%;
    }

    /* While a card is being edited, give every editable field a visible 1px
       border so it's obvious which values can be changed (in display mode the
       fields render as plain text). */
    .inputs-table tr.mobile-card-editing td :global(input),
    .inputs-table tr.mobile-card-editing td :global(select),
    .inputs-table tr.mobile-card-editing td :global(textarea) {
      border: 1px solid color-mix(in oklab, var(--cardBorder) 60%, transparent);
      border-radius: 6px;
      padding: 0.2rem 0.35rem;
    }

    /* Dose and mg-in-system sit beside their label on the same line (not on a
       full-width line below it). They take the width the label leaves and
       right-align their content, so when the value has to wrap — extra drug rows
       in the stack, or a vial chip + number too wide to sit beside "Dose" — every
       line keeps that same reduced width and stays right-aligned. */
    .inputs-table td .dose-entry,
    .inputs-table td .system-stack {
      flex: 1 1 auto;
      min-width: 0;
    }

    .inputs-table td .dose-entry {
      flex-wrap: wrap;
    }

    .inputs-table td .system-stack {
      align-items: flex-end;
    }

    /* ── Per-card edit action buttons (shown in the header row when editing) ──
       Save / Delete / Cancel are all uniform icon squares with radiused corners,
       matching the Edit pencil. */
    .card-action-btn {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      padding: 0;
      border-radius: 8px;
      line-height: 0;
      cursor: pointer;
      border: 1.5px solid color-mix(in oklab, var(--cardBorder) 35%, #d4d4d4 65%);
      background: color-mix(in oklab, var(--surface) 82%, transparent);
      color: var(--text);
    }

    /* Muted fills: the green save used the vivid --accent; --success is the
       theme's softer green. Delete's red is toned down toward the surface so it
       reads less alarming. */
    .card-action-btn.card-save {
      border-color: transparent;
      background: color-mix(in oklab, var(--success) 88%, var(--surface) 12%);
      color: white;
    }

    .card-action-btn.card-delete {
      border-color: transparent;
      background: color-mix(in oklab, var(--danger) 78%, var(--surface) 22%);
      color: white;
    }

    /* Delete now lives in the per-card edit actions, so the gear's gutter
       trash-can and the Hidden-columns manager are redundant on mobile. */
    .row-delete-btn {
      display: none;
    }

    .hidden-columns-fieldset {
      display: none;
    }
  }
</style>

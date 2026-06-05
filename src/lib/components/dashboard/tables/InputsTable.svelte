<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import CustomPicker from '$lib/components/dashboard/tables/CustomPicker.svelte';
  import MultiPicker from '$lib/components/dashboard/tables/MultiPicker.svelte';
  import DateInput from '$lib/components/dashboard/tables/DateInput.svelte';
  import type { HealthInputRow, HealthSystemAmount } from '$lib/stores/healthTypes';
  import { weightUnit, displayWeight, toStoredLbs } from '$lib/stores/unitStore';
  import { medicationRows } from '$lib/stores/medicationStore';
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
    deleteWeight,
    deleteInjection,
    getAllInjections,
    getAllWeights,
    updateInjection,
    updateWeight,
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
  import type { HealthColKey, InjectionEntry, IsoDate, Medication, WeightEntry } from '$lib/domain/types';

  type ColumnKey = HealthColKey;
  type ManagedOptionKind = 'symptom' | 'shotLocation';

  type Column = {
    key: ColumnKey;
    label: string;
  };

  type EditableInputRow = HealthInputRow & {
    draftId?: string;
  };

  type PersistableInputRow = {
    row: EditableInputRow;
    tableIndex: number;
  };

  type PersistedHealthRecords = {
    weights: WeightEntry[];
    injections: InjectionEntry[];
  };

  type OptionDeleteRequest = {
    kind: ManagedOptionKind;
    option: string;
    count: number;
  };

  let {
    rows = [],
    isEditing = false,
    isSettingsOpen = false,
    addRowSignal = 0,
    resetSignal = 0,
    saveSignal = 0,
    discardSignal = 0,
    onSaveEdits,
    onDraftRowsChange,
    onUnsavedChangesChange,
  }: {
    rows?: HealthInputRow[];
    isEditing?: boolean;
    isSettingsOpen?: boolean;
    addRowSignal?: number;
    resetSignal?: number;
    saveSignal?: number;
    discardSignal?: number;
    onSaveEdits?: () => void;
    onDraftRowsChange?: (hasDraftRows: boolean) => void;
    onUnsavedChangesChange?: (hasUnsavedChanges: boolean) => void;
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
  const columnSettingsOpen = $derived(isEditing && isSettingsOpen);

  const colIndicator = $derived.by((): { col: number; side: 'left' | 'right' } | null => {
    if (colDragIndex === null || colDragoverIndex === null) return null;
    if (colDragIndex === colDragoverIndex) return null;
    if (colDragIndex > colDragoverIndex) return { col: colDragoverIndex, side: 'left' };
    const next = colDragoverIndex + 1;
    return next < activeColumns.length ? { col: next, side: 'left' } : { col: colDragoverIndex, side: 'right' };
  });

  function reorderColumns(from: number, to: number) {
    if (!columnSettingsOpen) return;
    if (from === to) return;
    const visibleKeys = columnOrder.filter((key) => !hiddenColumns.has(key));
    if (!visibleKeys[from] || !visibleKeys[to]) return;

    const [moved] = visibleKeys.splice(from, 1);
    visibleKeys.splice(to, 0, moved);

    let visibleIndex = 0;
    columnOrder = columnOrder.map((key) =>
      hiddenColumns.has(key) ? key : visibleKeys[visibleIndex++],
    );
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
    const validKeys = new Set<ColumnKey>(DEFAULT_COL_ORDER);
    const merged = (savedOrder ?? []).filter((key): key is ColumnKey => validKeys.has(key as ColumnKey));

    for (const key of DEFAULT_COL_ORDER) {
      if (merged.includes(key)) continue;

      const defaultIndex = DEFAULT_COL_ORDER.indexOf(key);
      const previousKey = [...DEFAULT_COL_ORDER.slice(0, defaultIndex)]
        .reverse()
        .find((candidate) => merged.includes(candidate));

      if (previousKey) {
        merged.splice(merged.indexOf(previousKey) + 1, 0, key);
      } else {
        merged.unshift(key);
      }
    }

    return merged;
  }

  function applyHiddenColumnSettings(target: SvelteSet<ColumnKey>, savedHidden: string[] | undefined) {
    const validKeys = new Set<ColumnKey>(DEFAULT_COL_ORDER);
    target.clear();
    for (const key of savedHidden ?? []) {
      if (validKeys.has(key as ColumnKey)) target.add(key as ColumnKey);
    }
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
  // While editing/saving, the saved snapshot isn't displayed (see displayedRows),
  // so skip the heavy PK recompute and avoid taking a dependency on `rows`.
  const savedTableRows = $derived.by<EditableInputRow[]>(() =>
    isEditing ? [] : recalculateDerived(rows.map(cloneRow)),
  );
  const displayedRows = $derived.by(() =>
    isEditing ? tableRows : [...tableRows.filter(isDraftRow), ...savedTableRows],
  );

  // Keyed by stable row id — holds the raw typed string while the user is mid-entry
  // so we never clobber it with the lbs→display round-trip conversion on every keystroke.
  const weightDrafts = new SvelteMap<string, string>();

  function commitWeightDrafts() {
    if (weightDrafts.size === 0) return;
    let earliestChangedDate: string | undefined;
    const nextRows = tableRows.map((row, index) => {
      const draft = weightDrafts.get(rowKey(row, index));
      if (draft === undefined) return row;
      const nextRow = cloneRow(row);
      nextRow.weight = toStoredLbs(draft, $weightUnit);
      if (nextRow.date && (earliestChangedDate === undefined || nextRow.date < earliestChangedDate)) {
        earliestChangedDate = nextRow.date;
      }
      return nextRow;
    });
    tableRows = recalculateDerived(nextRows, false, earliestChangedDate, 'weight');
    weightDrafts.clear();
  }

  const shotLocationSelectOptions = $derived(['', ...$shotLocationOptions]);
  let newSymptomOption = $state('');
  let newSymptomColor = $state('#c8ccd4');
  let newShotLocationOption = $state('');
  let optionDeleteRequest = $state<OptionDeleteRequest | null>(null);

  let isSavingRows = $state(false);
  let expandedDueId = $state<string | null>(null);
  const todayKey = $derived(localDateKey());

  function isDueConfirmation(row: EditableInputRow): boolean {
    return (
      !!row.injectionId &&
      row.dosePlanned === true &&
      !row.doseSkipped &&
      typeof row.date === 'string' &&
      row.date <= todayKey
    );
  }

  function patchRowById(rows: EditableInputRow[], injectionId: string, patch: Partial<HealthInputRow>): EditableInputRow[] {
    return rows.map((row) => (row.injectionId === injectionId ? { ...cloneRow(row), ...patch } : row));
  }

  async function applyDoseDecision(row: EditableInputRow, decision: 'taken' | 'skipped') {
    if (!row.injectionId) return;
    const id = row.injectionId;
    const patch: Partial<HealthInputRow> =
      decision === 'taken'
        ? { dosePlanned: false, doseSkipped: false, doseConfirmedAt: new Date().toISOString() }
        : { dosePlanned: false, doseSkipped: true, doseConfirmedAt: undefined };

    const affectedDate = tableRows.find((r) => r.injectionId === id)?.date;
    tableRows = recalculateDerived(patchRowById(tableRows, id, patch), false, affectedDate, 'pk');
    draftBaseTableRows = patchRowById(draftBaseTableRows, id, patch);
    expandedDueId = null;

    try {
      await updateInjection(id, {
        planned: false,
        confirmedAt: decision === 'taken' ? patch.doseConfirmedAt : undefined,
        skipped: decision === 'skipped',
      });
    } catch (err) {
      console.error('Failed to update dose status:', err);
    }
  }

  function toggleDuePanel(row: EditableInputRow) {
    if (!row.injectionId) return;
    expandedDueId = expandedDueId === row.injectionId ? null : row.injectionId;
  }

  function handleDuePanelKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && expandedDueId !== null) {
      expandedDueId = null;
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
  }

  let nextDraftRowId = 0;
  let lastAddRowSignal = getInitialAddRowSignal();
  let lastResetSignal = getInitialResetSignal();
  let lastSaveSignal = getInitialSaveSignal();
  let lastDiscardSignal = getInitialDiscardSignal();
  let lastNotifiedUnsavedChanges = false;
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
    if (!isEditing && !hasUnsavedChanges) {
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
    if (resetSignal === lastResetSignal) return;
    lastResetSignal = resetSignal;
    resetTable();
  });

  $effect(() => {
    if (columnSettingsOpen) return;
    resetColumnInteractionState();
  });

  const visibleColumns = $derived(
    (isEditing ? columns : savedColumns).filter((column) =>
      !(isEditing ? hiddenColumns : savedHiddenColumns).has(column.key),
    ),
  );
  const hiddenColumnOptions = $derived(columns.filter((column) => hiddenColumns.has(column.key)));
  const activeColumns = $derived(visibleColumns);
  const stretchColumnKey = $derived(
    activeColumns.some((column) => column.key === 'notes')
      ? 'notes'
      : activeColumns[activeColumns.length - 1]?.key,
  );
  const hasUnsavedChanges = $derived.by(() => {
    return (
      weightDrafts.size > 0 ||
      !rowsMatch(tableRowsWithCommittedWeightDrafts(), draftBaseTableRows)
    );
  });

  $effect(() => {
    if (saveSignal === lastSaveSignal) return;
    lastSaveSignal = saveSignal;
    void saveTableRows(true).then(() => {
      if (isEditing) onSaveEdits?.();
    });
  });

  $effect(() => {
    if (discardSignal === lastDiscardSignal) return;
    lastDiscardSignal = discardSignal;
    discardTableChanges();
  });

  $effect(() => {
    if (hasUnsavedChanges === lastNotifiedUnsavedChanges) return;
    lastNotifiedUnsavedChanges = hasUnsavedChanges;
    onDraftRowsChange?.(hasUnsavedChanges);
    onUnsavedChangesChange?.(hasUnsavedChanges);
  });

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
    if (prefix.length !== n + 1) prefix = new Array(n + 1);
    prefix[0] = 0;
    for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + heightAt(i);
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
    let lo = 0;
    let hi = rowHeights.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefix[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function tbodyTop(): number {
    const tbody = tableEl?.tBodies[0];
    return (tbody ?? tableEl)?.getBoundingClientRect().top ?? 0;
  }

  function recomputeVisibleRange() {
    if (!tableEl) return;
    const rowCount = displayedRows.length;
    ensureLen(rowCount);
    if (rowCount === 0) {
      firstVisibleIndex = 0;
      lastVisibleIndex = 0;
      topSpacerHeight = 0;
      bottomSpacerHeight = 0;
      return;
    }
    // Offsets are measured from the tbody's content top (= row 0's top), which
    // already excludes the thead and accounts for the current top spacer.
    const top = tbodyTop();
    const scrolledPast = Math.max(0, -top);
    const bottomFromTop = Math.max(0, window.innerHeight - top);

    let nextFirst = indexAtOffset(scrolledPast) - ROW_OVERSCAN;
    if (nextFirst < 0) nextFirst = 0;
    let nextLast = indexAtOffset(bottomFromTop) + ROW_OVERSCAN;
    if (nextLast > rowCount - 1) nextLast = rowCount - 1;
    if (nextLast < nextFirst) nextLast = nextFirst;

    firstVisibleIndex = nextFirst;
    lastVisibleIndex = nextLast;
    topSpacerHeight = prefix[nextFirst];
    bottomSpacerHeight = Math.max(0, prefix[rowCount] - prefix[nextLast + 1]);
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
  }

  // Resize the cache and recompute when rows are added/removed.
  $effect(() => {
    displayedRowsLength;
    if (!tableEl) return;
    ensureLen(displayedRowsLength);
    recomputeVisibleRange();
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
    isEditing;
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
  }

  async function deleteRow(row: EditableInputRow) {
    if (!isDraftRow(row)) {
      if (!confirm('Delete this row? This cannot be undone.')) return;
      await Promise.all([
        row.weightId ? deleteWeight(row.weightId) : Promise.resolve(),
        row.injectionId ? deleteInjection(row.injectionId) : Promise.resolve(),
      ]);
    }
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

  function discardTableChanges() {
    weightDrafts.clear();
    const base = recalculateDerived(rows.map(cloneRow));
    tableRows = base;
    draftBaseTableRows = base.map(cloneRow);
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

  function getInitialResetSignal(): number {
    return resetSignal;
  }

  function getInitialSaveSignal(): number {
    return saveSignal;
  }

  function getInitialDiscardSignal(): number {
    return discardSignal;
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
    return row.draftId ?? row.injectionId ?? row.weightId ?? `${row.date}-${rowIndex}`;
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
      !!row.injectionId &&
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
      weightId: row.weightId,
      injectionId: row.injectionId,
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
    };
  }

  function mergeSavedInputRow(row: HealthInputRow, saved: SavedHealthInputRow): HealthInputRow {
    const nextRow = { ...row, weightId: saved.weightId, injectionId: saved.injectionId };

    if (saved.injectionSaved) {
      nextRow.medication = saved.medication ?? '';
      nextRow.dosePlanned = saved.dosePlanned ?? false;
      nextRow.doseConfirmedAt = saved.doseConfirmedAt;
      nextRow.doseSkipped = saved.doseSkipped ?? false;
    }

    return nextRow;
  }

  function stripDraftMetadata(row: EditableInputRow): HealthInputRow {
    const { draftId, ...rowWithoutDraftId } = cloneRow(row);
    return rowWithoutDraftId;
  }

  function normalizeWellnessRow<T extends HealthInputRow>(row: T): T {
    if (!row.wellness.trim()) return row;
    return { ...row, wellness: normalizeWellnessScoreInput(row.wellness) };
  }

  function getRowsToPersist(includeExistingRows: boolean): PersistableInputRow[] {
    return tableRows.map((row, tableIndex) => ({ row, tableIndex })).filter(({ row, tableIndex }) => {
      if (!isDraftRow(row)) return includeExistingRows && rowHasUserChanges(row, tableIndex);
      return hasPersistableData(row);
    });
  }

  async function persistRows(rowsToPersist: PersistableInputRow[]): Promise<HealthInputRow[]> {
    const confirmationTimestamp = new Date().toISOString();
    const saveEntries = rowsToPersist.map(({ row, tableIndex }) => ({
      row: normalizeWellnessRow(stripDraftMetadata(row)),
      confirmedAt: shouldConfirmEditedPlannedDose(row, tableIndex) ? confirmationTimestamp : undefined,
    }));
    const savedRows = await saveInputRows(
      saveEntries.map((entry) => toSaveInputRow(entry.row, entry.confirmedAt)),
      { defaultMedication: defaultMedication as Medication | '' },
    );

    return saveEntries.map((entry, index) => mergeSavedInputRow(entry.row, savedRows[index]));
  }

  async function saveTableRows(includeExistingRows = false) {
    if (isSavingRows) return;
    commitWeightDrafts();
    const rowsToPersist = getRowsToPersist(includeExistingRows);
    // Existing rows that aren't changing this save stay as-is. Empty drafts
    // (not in rowsToPersist) are dropped, matching previous behavior.
    const persistKeys = new Set(rowsToPersist.map(({ row, tableIndex }) => rowKey(row, tableIndex)));
    const rowsToKeep = tableRows
      .filter((row, idx) => !isDraftRow(row) && !persistKeys.has(rowKey(row, idx)))
      .map(stripDraftMetadata);

    isSavingRows = true;
    try {
      const persistedRows = await persistRows(rowsToPersist);
      const earliestChangedDate = rowsToPersist.reduce<string | undefined>(
        (min, { row }) => (min === undefined || row.date < min ? row.date : min),
        undefined,
      );
      tableRows = recalculateDerived([...rowsToKeep, ...persistedRows], false, earliestChangedDate);
      markRowsAsBaseline();
    } catch (err) {
      console.error('Failed to save row data:', err);
    } finally {
      isSavingRows = false;
    }

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

  function isRowEditable(row: EditableInputRow): boolean {
    return isEditing || isDraftRow(row);
  }

  // For the ≤640px card layout: a read-only row hides its empty fields so sparse
  // days collapse to just what was logged. `day`/`date` always show (they're the
  // card's identity). Editable rows never hide cells — every input stays
  // reachable. Mirrors the empty checks used by each column's render branch.
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

  function requestSaveRows() {
    void saveTableRows(true).then(() => {
      if (isEditing) onSaveEdits?.();
    });
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

  function releaseActiveDiscreteControlFocus() {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLSelectElement ||
      (activeElement instanceof HTMLInputElement && activeElement.type === 'date')
    ) {
      activeElement.blur();
    }
  }

  function releaseDiscreteControlFocus(element: HTMLInputElement | HTMLSelectElement) {
    const release = () => {
      element.blur();
      releaseActiveDiscreteControlFocus();
    };

    requestAnimationFrame(release);
    setTimeout(release, 0);
    setTimeout(release, 75);
    setTimeout(release, 200);
  }

  function updateCellAndReleaseFocus(
    index: number,
    key: ColumnKey,
    value: string,
    element: HTMLInputElement | HTMLSelectElement,
  ) {
    updateCell(index, key, value);
    releaseDiscreteControlFocus(element);
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

    return (
      records.weights.reduce((count, weight) => count + countMatches(weight.symptoms), 0) +
      records.injections.reduce((count, injection) => count + countMatches(injection.symptoms), 0)
    );
  }

  function countPersistedOptionRecords(records: PersistedHealthRecords, kind: ManagedOptionKind, option: string): number {
    if (kind === 'shotLocation') {
      return records.injections.filter((injection) => injection.site === option).length;
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
    const [weights, injections] = await Promise.all([getAllWeights(), getAllInjections()]);
    return { weights, injections };
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
        records.injections
          .filter((injection) => injection.site === option)
          .map((injection) => updateInjection(injection.id, { site: '' })),
      );
      return;
    }

    await Promise.all([
      ...records.weights
        .filter((weight) => (weight.symptoms ?? []).includes(option))
        .map((weight) =>
          updateWeight(weight.id, {
            symptoms: (weight.symptoms ?? []).filter((symptom) => symptom !== option),
          }),
        ),
      ...records.injections
        .filter((injection) => (injection.symptoms ?? []).includes(option))
        .map((injection) =>
          updateInjection(injection.id, {
            symptoms: (injection.symptoms ?? []).filter((symptom) => symptom !== option),
          }),
        ),
    ]);
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

  function handleInputCommitKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && optionDeleteRequest !== null) {
      optionDeleteRequest = null;
      return;
    }

    if (event.key === 'Escape' && expandedDueId !== null) {
      expandedDueId = null;
      return;
    }

    if (!(event.target instanceof Node) || !inputsTableRegion?.contains(event.target)) return;

    if (
      event.key !== 'Enter' ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    if (!hasUnsavedChanges && !isEditing) return;

    event.preventDefault();
    requestSaveRows();
  }
</script>

<svelte:document onkeydown={handleInputCommitKeydown} onclick={handleDocumentClickForDuePanel} />

<div class="inputs-table-region" bind:this={inputsTableRegion}>
  {#if columnSettingsOpen}
    <section class="column-manager" aria-label="Column visibility and option settings">
      <div class="option-managers">
        <fieldset>
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
    <table bind:this={tableEl} class="inputs-table" class:inputs-table--editing={isEditing}>
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
                    onkeydown={(e) => colKeydown(e, colIndex)}
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
        {#if topSpacerHeight > 0}
          <tr aria-hidden="true" class="virtual-spacer">
            <td colspan={activeColumns.length + 1} style={`height:${topSpacerHeight}px`}></td>
          </tr>
        {/if}
        {#each visibleRows as row, sliceIndex (rowKey(row, firstVisibleIndex + sliceIndex))}
          {@const rowIndex = firstVisibleIndex + sliceIndex}
          {@const dueConfirm = isDueConfirmation(row)}
          {@const isExpanded = !!row.injectionId && expandedDueId === row.injectionId}
          <tr
            class:row-alt={rowIndex % 2 === 1}
            class:new-row={isDraftRow(row)}
            class:row-skipped={row.doseSkipped}
            class:row-needs-medication={rowMissingMedication(row)}
          >
            <td class="due-action-cell">
              {#if dueConfirm}
                <div class="due-action-wrap">
                  <button
                    type="button"
                    class="due-action-btn"
                    class:expanded={isExpanded}
                    aria-label="Confirm whether this dose was taken"
                    aria-expanded={isExpanded}
                    title="Confirm whether this dose was taken"
                    onclick={() => toggleDuePanel(row)}
                    onkeydown={handleDuePanelKeydown}
                  >!</button>
                  {#if isExpanded}
                    <div class="due-action-panel" role="group" aria-label="Confirm planned dose">
                      <button
                        type="button"
                        class="due-action-confirm"
                        onclick={() => applyDoseDecision(row, 'taken')}
                      >Taken</button>
                      <button
                        type="button"
                        class="due-action-skip"
                        onclick={() => applyDoseDecision(row, 'skipped')}
                      >Skip</button>
                    </div>
                  {/if}
                </div>
              {/if}
            </td>
            {#each activeColumns as column, colIndex (column.key)}
              <td
                class={column.key}
                data-label={column.label}
                class:empty-cell={!isRowEditable(row) && isCellEmpty(row, column.key)}
                class:col-indicator-left={columnSettingsOpen && colIndicator?.col === colIndex && colIndicator?.side === 'left'}
                class:col-indicator-right={columnSettingsOpen && colIndicator?.col === colIndex && colIndicator?.side === 'right'}
              >
                {#if isRowEditable(row) && column.key !== 'symptoms' && column.key !== 'shotLocation'}
                  {#if column.key === 'day' || column.key === 'loss' || column.key === 'system'}
                    {#if column.key === 'system'}
                      {@render systemStack(row)}
                    {:else if column.key === 'loss'}
                      {displayWeight(row.loss, $weightUnit)}
                    {:else}
                      {#if isEditing}
                        <div class="day-delete-cell">
                          <span>{row[column.key]}</span>
                          <button
                            type="button"
                            class="delete-btn"
                            aria-label={`Delete row for ${row.date}`}
                            onclick={() => deleteRow(row)}
                          >×</button>
                        </div>
                      {:else}
                        {row[column.key]}
                      {/if}
                    {/if}
                  {:else if column.key === 'date'}
                  <DateInput
                    value={row.date}
                    onchange={(v) => updateCell(rowIndex, 'date', v)}
                  />
                  {:else if column.key === 'weight'}
                  <input
                    type="text"
                    value={weightDrafts.has(rowKey(row, rowIndex)) ? (weightDrafts.get(rowKey(row, rowIndex)) ?? '') : displayWeight(row.weight, $weightUnit)}
                    oninput={(event) => { weightDrafts.set(rowKey(row, rowIndex), event.currentTarget.value); }}
                    onblur={() => {
                      const key = rowKey(row, rowIndex);
                      const draft = weightDrafts.get(key);
                      if (draft !== undefined) {
                        updateCell(rowIndex, 'weight', toStoredLbs(draft, $weightUnit));
                        weightDrafts.delete(key);
                      }
                    }}
                    placeholder={isDraftRow(row) ? `Weight (${$weightUnit})` : undefined}
                  />
                  {:else if column.key === 'dose'}
                  <div class="dose-entry">
                    <input
                      type="text"
                      value={row.dose}
                      oninput={(event) => updateCell(rowIndex, 'dose', event.currentTarget.value)}
                      placeholder={isDraftRow(row) ? 'New dose' : undefined}
                    />
                    <CustomPicker
                      value={row.medication}
                      options={medicationOptions}
                      invalid={rowMissingMedication(row)}
                      onSelect={(value) => updateCell(rowIndex, 'medication', value)}
                      ariaLabel={isDraftRow(row) ? 'Medication for new dose' : 'Medication'}
                    />
                    {#if rowMissingMedication(row)}
                      <p class="medication-warning" role="alert">
                        Pick a medication so this dose shows on the graph.
                      </p>
                    {/if}
                  </div>
                  {:else if column.key === 'wellness'}
                  <input
                    type="number"
                    value={row.wellness}
                    min={WELLNESS_SCORE_MIN}
                    max={WELLNESS_SCORE_MAX}
                    step="1"
                    title={`Wellness score ${WELLNESS_SCORE_MIN}-${WELLNESS_SCORE_MAX}`}
                    oninput={(event) => updateCell(rowIndex, 'wellness', event.currentTarget.value)}
                    onblur={(event) => commitWellnessInput(rowIndex, event.currentTarget.value)}
                    placeholder={`${WELLNESS_SCORE_MIN}-${WELLNESS_SCORE_MAX}`}
                  />
                  {:else}
                  <input
                    type="text"
                    value={row[column.key]}
                    oninput={(event) => updateCell(rowIndex, column.key, event.currentTarget.value)}
                    placeholder={isDraftRow(row) ? `New ${column.label.toLowerCase()}` : undefined}
                  />
                  {/if}
                {:else if isRowEditable(row) && column.key === 'shotLocation'}
                  <CustomPicker
                    value={row.shotLocation}
                    options={optionsWithCurrent(shotLocationSelectOptions, row.shotLocation)}
                    onSelect={(value) => updateCell(rowIndex, 'shotLocation', value)}
                    ariaLabel={isDraftRow(row) ? 'Shot location for new dose' : 'Shot location'}
                  />
                {:else if isRowEditable(row) && column.key === 'symptoms'}
                  <MultiPicker
                    values={row.symptoms}
                    options={$symptomOptions}
                    optionColor={symptomColor}
                    onToggle={(symptom) =>
                      updateCell(rowIndex, 'symptoms', toggleSymptomValue(symptom, row.symptoms))}
                    ariaLabel={isDraftRow(row) ? 'Symptoms for new row' : `Symptoms for row ${rowIndex + 1}`}
                  />
                {:else if column.key === 'symptoms'}
                  <div class="symptoms-cell">
                    {#each row.symptoms as symptom (symptom)}
                      <span class="pill" style={`background:${symptomColor(symptom)}`}>{symptom}</span>
                    {/each}
                  </div>
                {:else if column.key === 'system'}
                  {@render systemStack(row)}
                {:else if column.key === 'weight'}
                  {fmtNum(lbsToDisplayNum(row.weight, $weightUnit), weightDecimals)}
                {:else if column.key === 'dose'}
                  {fmtNum(parseFloat(row.dose), doseDecimals)}
                  {#if rowMissingMedication(row)}
                    <span
                      class="medication-warning-icon"
                      title="No medication set — this dose is not shown on the graph."
                      aria-label="No medication set — this dose is not shown on the graph."
                    >⚠</span>
                  {/if}
                {:else if column.key === 'loss'}
                  {displayWeight(row.loss, $weightUnit)}
                {:else if column.key === 'wellness'}
                  {normalizeWellnessScoreInput(row.wellness)}
                {:else if column.key === 'date'}
                  {formatLocaleDate(row.date)}
                {:else}
                  {row[column.key]}
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
  .column-manager {
    border: 2px solid color-mix(in oklab, var(--cardBorder) 40%, white 60%);
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
    border: 2px solid color-mix(in oklab, var(--cardBorder) 48%, white 52%);
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
    vertical-align: top;
    text-align: center;
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

  .inputs-table--editing th.dose,
  .inputs-table--editing td.dose,
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

  .symptoms-cell {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
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

  .dose-entry {
    display: grid;
    gap: 0.3rem;
  }

  .pill {
    border-radius: 999px;
    padding: 0.14rem 0.5rem;
    font-size: 0.95rem;
    color: var(--text);
    white-space: nowrap;
  }

  .new-row {
    border-top: 2px solid color-mix(in oklab, var(--cardBorder) 30%, white 70%);
  }

  .virtual-spacer td {
    padding: 0;
    border: 0;
    background: transparent;
  }

  .row-needs-medication td:first-of-type {
    box-shadow: inset 3px 0 0 var(--danger);
  }

  .medication-warning {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.25;
    color: var(--danger);
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
    border: 2px solid var(--warning);
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
    background: var(--headerBg);
    color: var(--headerText);
    border: 2px solid var(--headerBg);
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
    border: 2px solid var(--cardBorder);
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

  /* ── Desktop (≥641px): the due-confirm badge sits against the card border ──
   * On mobile each row is a card and this button floats in the card corner (see
   * the ≤640px block); the dedicated column + zero-width header exist only to
   * support that layout. On desktop the table is flat, so the column reserves no
   * width — the badge is pushed left until it meets the card's border and lifted
   * above everything (overlapping the leading cell's content is fine). The badge
   * lands in the card padding, outside the table's content box, so the scroll
   * viewport would normally clip it; the .table-scroll rule below extends the
   * clip region left to cover it without moving the table or adding a gutter. */
  @media (min-width: 641px) {
    /* Extend the scroll viewport left into the card padding so the badge isn't
     * clipped by overflow: the negative margin pulls the box left, the matching
     * padding restores the table's position, and the width/​max-width reclaim
     * keeps the right edge. Horizontal scrolling for wide tables still works. */
    .table-scroll {
      margin-left: -1rem;
      padding-left: 1rem;
      width: calc(100% + 1rem);
      max-width: none;
    }

    .inputs-table col.col-due-action {
      width: 0;
    }

    .inputs-table th.due-action-header,
    .inputs-table td.due-action-cell {
      width: 0;
      padding: 0;
      overflow: visible;
    }

    .inputs-table td.due-action-cell .due-action-wrap {
      position: absolute;
      /* Left of the table's content edge (one padding-width, plus the table's
       * leading cell-spacing) so the badge sits flush against the card border. */
      left: -0.9rem;
      top: 50%;
      transform: translateY(-50%);
      z-index: 10;
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

  .day-delete-cell {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }

  .delete-btn {
    border: 0;
    border-radius: 8px;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    background: color-mix(in oklab, var(--danger) 12%, transparent 88%);
    color: var(--danger);
    font-size: 1.1rem;
    font-weight: 700;
    line-height: 0;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
  }

  .delete-btn:hover {
    background: color-mix(in oklab, var(--danger) 25%, transparent 75%);
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
      border: 2px solid color-mix(in oklab, var(--cardBorder) 40%, #f0f0f0 60%);
      border-radius: 12px;
      padding: 0.4rem 0.7rem 0.55rem;
      margin-bottom: 0.6rem;
      /* Opaque base: the row tint is semi-transparent (rgba ~0.14), so paint it
       * over --surface like MedicationTab does, ready for a chip-strip skirt. */
      background: var(--surface);
    }

    .inputs-table tbody tr.row-alt {
      background: linear-gradient(var(--rowAlt), var(--rowAlt)), var(--surface);
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
      gap: 0.25rem 0.75rem;
      text-align: right;
      border: none;
      border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 22%, transparent);
      padding: 0.34rem 0;
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

    /* The date is the card's top line / title. order:-1 lifts it above the Day
     * row so its empty right side hosts the due-confirm button; padding-right
     * reserves room so a long locale date never runs under that button. */
    .inputs-table td.date {
      order: -1;
      justify-content: flex-start;
      border-bottom: 2px solid color-mix(in oklab, var(--cardBorder) 32%, transparent);
      padding-top: 0.1rem;
      padding-right: 2.2rem;
      margin-bottom: 0.15rem;
      font-weight: 700;
      font-size: 1.05rem;
    }

    .inputs-table td.date::before {
      content: none;
    }

    /* Due-confirm action floats in the card's top-right; absent ones vanish. */
    .inputs-table td.due-action-cell {
      position: absolute;
      top: 0.4rem;
      right: 0.7rem;
      width: auto;
      padding: 0;
      border: none;
    }

    .inputs-table td.due-action-cell:not(:has(.due-action-wrap)) {
      display: none;
    }

    .inputs-table td.due-action-cell::before {
      content: none;
    }

    /* Anchor the Taken/Skip popover to the card edge, not off-screen right. */
    .inputs-table td.due-action-cell .due-action-panel {
      left: auto;
      right: 0;
    }

    /* Inputs/pickers share the row with their label rather than filling it. */
    .inputs-table td :global(input),
    .inputs-table td :global(select) {
      width: auto;
      flex: 1 1 0;
      min-width: 0;
      max-width: 62%;
    }

    /* Richer value blocks wrap to full width under their label. */
    .inputs-table td .dose-entry,
    .inputs-table td .system-stack,
    .inputs-table td .symptoms-cell {
      flex: 1 1 100%;
      min-width: 0;
    }

    .inputs-table td .system-stack,
    .inputs-table td .symptoms-cell {
      align-items: flex-end;
    }
  }
</style>

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
  const ROW_OVERSCAN = 8;
  let tableEl: HTMLTableElement | undefined = $state();
  let measuredRowHeight = $state(40);
  let firstVisibleIndex = $state(0);
  let lastVisibleIndex = $state(80);

  // A stable primitive: re-fires only when the count actually changes, unlike
  // `displayedRows` whose reference shifts on every keystroke.
  const displayedRowsLength = $derived(displayedRows.length);

  function recomputeVisibleRange() {
    if (!tableEl) return;
    const rowCount = displayedRows.length;
    if (rowCount === 0) {
      firstVisibleIndex = 0;
      lastVisibleIndex = 0;
      return;
    }
    const rect = tableEl.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const scrolledPast = Math.max(0, -rect.top);
    const bottomFromTableTop = viewportHeight - rect.top;
    const rowH = Math.max(measuredRowHeight, 1);
    const nextFirst = Math.max(0, Math.floor(scrolledPast / rowH) - ROW_OVERSCAN);
    const nextLast = Math.min(
      rowCount - 1,
      Math.max(nextFirst, Math.ceil(bottomFromTableTop / rowH) + ROW_OVERSCAN),
    );
    if (nextFirst !== firstVisibleIndex) firstVisibleIndex = nextFirst;
    if (nextLast !== lastVisibleIndex) lastVisibleIndex = nextLast;
  }

  // Average across every currently-rendered row (excluding spacers) so an
  // unusually tall or short row doesn't poison the estimate. When the height
  // does change, scroll-compensate so visible content stays in the same place.
  function measureAndAdjustRowHeight() {
    if (!tableEl) return;
    const sampleRows = tableEl.querySelectorAll<HTMLElement>('tbody tr:not(.virtual-spacer)');
    if (sampleRows.length === 0) return;
    let total = 0;
    let count = 0;
    for (const row of sampleRows) {
      const h = row.getBoundingClientRect().height;
      if (h > 0) {
        total += h;
        count += 1;
      }
    }
    if (count === 0) return;
    const nextHeight = total / count;
    if (Math.abs(nextHeight - measuredRowHeight) < 2) return;

    const previousHeight = measuredRowHeight;
    measuredRowHeight = nextHeight;

    if (previousHeight > 0) {
      const rect = tableEl.getBoundingClientRect();
      const scrolledPast = Math.max(0, -rect.top);
      if (scrolledPast > 0) {
        const delta = scrolledPast * (nextHeight / previousHeight - 1);
        if (Math.abs(delta) > 1) {
          window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
        }
      }
    }
  }

  $effect(() => {
    if (!tableEl) return;
    let scrollRaf = 0;
    let resizeRaf = 0;
    const onScroll = () => {
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
        measureAndAdjustRowHeight();
        recomputeVisibleRange();
      });
    };
    // Fires when the table goes 0 → real size (hidden tab becomes active) so
    // measurements taken while hidden don't leave the visible range stale.
    const tableObserver = new ResizeObserver(onResize);
    tableObserver.observe(tableEl);
    recomputeVisibleRange();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      tableObserver.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  });

  // Re-measure only on structural changes: mode toggle or row add/remove.
  // Keystrokes inside a row do NOT trigger this, so typing won't cause the
  // spacer heights to jump and yank focus away.
  $effect(() => {
    isEditing;
    displayedRowsLength;
    if (!tableEl) return;
    queueMicrotask(() => {
      measureAndAdjustRowHeight();
      recomputeVisibleRange();
    });
  });

  const visibleRows = $derived(displayedRows.slice(firstVisibleIndex, lastVisibleIndex + 1));
  const topSpacerHeight = $derived(firstVisibleIndex * measuredRowHeight);
  const bottomSpacerHeight = $derived(
    Math.max(0, (displayedRows.length - 1 - lastVisibleIndex) * measuredRowHeight),
  );

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
    border: 2px solid var(--cardBorder);
    background: color-mix(in oklab, var(--headerBg) 18%, white 82%);
    color: var(--headerBg);
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
</style>

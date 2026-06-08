<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import GearIcon from '$lib/components/icons/GearIcon.svelte';
  import { columnDecimals, fmtNum } from '$lib/utils/format';
  import type { MedicationInputRow } from '$lib/stores/medicationStore';
  import { rawPrescriptions, rawEntries, isConsumingDose, vialLevels } from '$lib/stores/medicationStore';
  import { computeVialLevels, manualMgUsedForDesiredLeft, type VialLevel } from '$lib/utils/vialLevels';
  import { vialUnit } from '$lib/stores/vialUnitStore';
  import { dismissedReminders } from '$lib/stores/dismissedRemindersStore';
  import { weightUnit, displayWeight } from '$lib/stores/unitStore';
  import { currentWeight, startWeight } from '$lib/stores/progressStore';
  import { addPrescription, updatePrescription, deletePrescription, getProfile, saveProfile } from '$lib/domain/repo';
  import DateInput from '$lib/components/dashboard/tables/DateInput.svelte';
  import CustomPicker from '$lib/components/dashboard/tables/CustomPicker.svelte';
  import ConfirmDialog from '$lib/components/dashboard/tables/ConfirmDialog.svelte';
  import EditPencil from '$lib/components/dashboard/EditPencil.svelte';
  import SaveIcon from '$lib/components/icons/SaveIcon.svelte';
  import TrashIcon from '$lib/components/icons/TrashIcon.svelte';
  import ArchiveIcon from '$lib/components/icons/ArchiveIcon.svelte';
  import { GridSelection } from '$lib/grid/gridSelection.svelte';
  import { isMobile } from '$lib/stores/viewport';
  import { addDays, daysBetween, formatLocaleDate, formatShortDate, localDateKey } from '$lib/utils/dateKeys';
  import {
    MEDICATIONS,
    type DosageColKey,
    type IsoDate,
    type Medication,
    type Prescription,
    type PrescriptionStatus,
    type VialColKey,
  } from '$lib/domain/types';

  type VialTrackingRow = {
    vialId: number;
    dbId: string;
    compoundDate: IsoDate | '';
    bud: IsoDate | '';
    lotNumber: string;
  };

  type TableColumn<Key extends string> = {
    key: Key;
    label: string;
  };

  const DEFAULT_DOSAGE_COLS: TableColumn<DosageColKey>[] = [
    { key: 'type', label: 'Type' },
    { key: 'concentration', label: 'Concentration (mg/mL)' },
    { key: 'additive', label: 'Additive' },
    { key: 'mlInVial', label: 'ml in Vial' },
    { key: 'prescribedDosage', label: 'Prescribed Dosage (mg)' },
    { key: 'dosesLeft', label: 'Doses Left' },
  ];

  let dosageCols = $state<TableColumn<DosageColKey>[]>([...DEFAULT_DOSAGE_COLS]);
  let savedDosageCols = $state<TableColumn<DosageColKey>[]>([...DEFAULT_DOSAGE_COLS]);

  const typeOptions: string[] = ['', ...MEDICATIONS];

  let {
    active = true,
    discardSignal = 0,
    onUnsavedChange,
  }: {
    active?: boolean;
    discardSignal?: number;
    onUnsavedChange?: (hasUnsavedChanges: boolean) => void;
  } = $props();

  // The tables are always editable now (auto-save, like the inputs table). This
  // flag stays `true`; structural ops (row/column drag, delete, archive) live
  // behind the settings gear instead.
  const editable = true;
  let settingsOpen = $state(false);
  let activeMedTab = $state<'dosage' | 'vial'>('dosage');
  let showArchivedVials = $state(false);

  let medTableCardRegion: HTMLElement | undefined = $state();

  const hiddenDosageCols = new SvelteSet<DosageColKey>();
  const savedHiddenDosageCols = new SvelteSet<DosageColKey>();
  const visibleDosageCols = $derived(dosageCols.filter((c) => !hiddenDosageCols.has(c.key)));
  const savedVisibleDosageCols = $derived(savedDosageCols.filter((c) => !savedHiddenDosageCols.has(c.key)));
  const hiddenDosageColumnOptions = $derived(dosageCols.filter((c) => hiddenDosageCols.has(c.key)));
  const activeDosageCols = $derived(editable ? visibleDosageCols : savedVisibleDosageCols);
  const dosageSettingsActive = $derived(editable && settingsOpen);

  const DEFAULT_VIAL_COLS: TableColumn<VialColKey>[] = [
    { key: 'compoundDate', label: 'Compound Date' },
    { key: 'bud', label: 'BUD' },
    { key: 'pharmacy', label: 'Pharmacy' },
    { key: 'lotNumber', label: 'Lot Number' },
    { key: 'cost', label: 'Cost' },
    { key: 'costPerMg', label: '$/mg' },
  ];

  let vialTrackingCols = $state<TableColumn<VialColKey>[]>([...DEFAULT_VIAL_COLS]);
  let savedVialTrackingCols = $state<TableColumn<VialColKey>[]>([...DEFAULT_VIAL_COLS]);

  const hiddenVialCols = new SvelteSet<VialColKey>();
  const savedHiddenVialCols = new SvelteSet<VialColKey>();
  const visibleVialCols = $derived(vialTrackingCols.filter((c) => !hiddenVialCols.has(c.key)));
  const savedVisibleVialCols = $derived(savedVialTrackingCols.filter((c) => !savedHiddenVialCols.has(c.key)));
  const hiddenVialColumnOptions = $derived(vialTrackingCols.filter((c) => hiddenVialCols.has(c.key)));
  const activeVialCols = $derived(editable ? visibleVialCols : savedVisibleVialCols);
  const vialSettingsActive = $derived(editable && settingsOpen);

  function getMedRowById(id: number): MedicationInputRow | undefined {
    const sourceRows = editable ? medicationInputRows : savedMedicationInputRows;
    return sourceRows.find((r) => r.id === id);
  }

  function updateMedRowField(id: number, field: 'pharmacy' | 'cost', value: string | number) {
    medicationInputRows = medicationInputRows.map((r) =>
      r.id === id ? { ...r, [field]: value } : r
    );
    scheduleMedSave();
  }

  let dosageDragIndex = $state<number | null>(null);
  let dosageDragoverIndex = $state<number | null>(null);
  let dosageColDragIndex = $state<number | null>(null);
  let dosageColDragoverIndex = $state<number | null>(null);
  let vialDragIndex = $state<number | null>(null);
  let vialDragoverIndex = $state<number | null>(null);
  let vialColDragIndex = $state<number | null>(null);
  let vialColDragoverIndex = $state<number | null>(null);

  // Keyboard reorder state
  let dosageKbIndex = $state<number | null>(null);
  let dosageKbRowId = $state<number | null>(null);
  let dosageKbSnapshot = $state<MedicationInputRow[] | null>(null);
  let vialKbIndex = $state<number | null>(null);
  let vialKbVialId = $state<number | null>(null);
  let vialKbSnapshot = $state<{ inputRows: MedicationInputRow[]; vialRows: VialTrackingRow[] } | null>(null);
  let dosageColKbIndex = $state<number | null>(null);
  let vialColKbIndex = $state<number | null>(null);
  let announcement = $state('');

  const dosageColIndicator = $derived.by((): { col: number; side: 'left' | 'right' } | null => {
    if (dosageColDragIndex === null || dosageColDragoverIndex === null) return null;
    if (dosageColDragIndex === dosageColDragoverIndex) return null;
    if (dosageColDragIndex > dosageColDragoverIndex) return { col: dosageColDragoverIndex, side: 'left' };
    const next = dosageColDragoverIndex + 1;
    return next < activeDosageCols.length ? { col: next, side: 'left' } : { col: dosageColDragoverIndex, side: 'right' };
  });

  const vialColIndicator = $derived.by((): { col: number; side: 'left' | 'right' } | null => {
    if (vialColDragIndex === null || vialColDragoverIndex === null) return null;
    if (vialColDragIndex === vialColDragoverIndex) return null;
    if (vialColDragIndex > vialColDragoverIndex) return { col: vialColDragoverIndex, side: 'left' };
    const next = vialColDragoverIndex + 1;
    return next < activeVialCols.length ? { col: next, side: 'left' } : { col: vialColDragoverIndex, side: 'right' };
  });

  let medicationInputRows = $state<MedicationInputRow[]>([]);
  let savedMedicationInputRows = $state<MedicationInputRow[]>([]);
  let draftBaseMedicationInputRows = $state<MedicationInputRow[]>([]);
  let vialTrackingRows = $state<VialTrackingRow[]>([]);
  let savedVialTrackingRows = $state<VialTrackingRow[]>([]);
  let draftBaseVialTrackingRows = $state<VialTrackingRow[]>([]);
  // The full draft/saved arrays stay the source of truth for editing and
  // saving (commitVialOrder treats a missing dbId as a delete, so archived
  // rows must never be filtered *out* of them). We only filter the rendered
  // view: archived vials are hidden unless the user opts to show them.
  const sourceMedicationInputRows = $derived(editable ? medicationInputRows : savedMedicationInputRows);
  const sourceVialTrackingRows = $derived(editable ? vialTrackingRows : savedVialTrackingRows);
  const archivedRowIds = $derived(
    new Set(sourceMedicationInputRows.filter((r) => r.archived).map((r) => r.id)),
  );
  // Newest vials on top, vial #1 at the bottom — matching the inputs table and
  // efficacy card (earlier items at the bottom). Render-only: the underlying
  // arrays stay in canonical #1→N order, and rows are looked up by id for
  // drag/save/attribution, so only the visual order flips.
  const displayedMedicationInputRows = $derived(
    (showArchivedVials ? sourceMedicationInputRows : sourceMedicationInputRows.filter((r) => !r.archived))
      .slice()
      .reverse(),
  );
  const displayedVialTrackingRows = $derived(
    (showArchivedVials
      ? sourceVialTrackingRows
      : sourceVialTrackingRows.filter((r) => !archivedRowIds.has(r.vialId)))
      .slice()
      .reverse(),
  );
  const archivedVialCount = $derived(archivedRowIds.size);

  // ── Mobile per-card edit ───────────────────────────────────────────────────
  // At ≤640px both med tables re-flow to one card per vial and the desktop
  // keyboard grid is disabled. Each card carries its own Edit button: it opens
  // that vial (all fields shown) with Save / Cancel / Delete / Archive. Edits are
  // buffered — Cancel reverts from a snapshot of BOTH the dosage row and the vial
  // row (they share id), and autosave is suppressed while a card is open, so only
  // Save persists. (cloneMedicationRow/cloneVialRow are hoisted declarations.)
  let mobileEditId = $state<number | null>(null);
  let mobileMedSnapshot: MedicationInputRow | null = null;
  let mobileVialSnapshot: VialTrackingRow | null = null;
  let vialDeleteRequest = $state<number | null>(null);
  const mobileEditingActive = $derived($isMobile && mobileEditId !== null);
  function isRowMobileEditing(id: number): boolean {
    return $isMobile && mobileEditId === id;
  }
  function vialArchivable(id: number): boolean {
    const m = getMedRowById(id);
    return !!m && (m.archived || isVialEmpty(m));
  }
  function startMobileEdit(id: number) {
    mobileEditId = id;
    const med = medicationInputRows.find((r) => r.id === id);
    const vial = vialTrackingRows.find((r) => r.vialId === id);
    mobileMedSnapshot = med ? cloneMedicationRow(med) : null;
    mobileVialSnapshot = vial ? cloneVialRow(vial) : null;
  }
  function saveMobileEdit() {
    // Clear edit state first so the autosave guard no longer suppresses the save.
    mobileEditId = null;
    mobileMedSnapshot = null;
    mobileVialSnapshot = null;
    scheduleMedSave();
  }
  function cancelMobileEdit() {
    const id = mobileEditId;
    if (id != null) {
      if (mobileMedSnapshot) {
        const snap = mobileMedSnapshot;
        medicationInputRows = medicationInputRows.map((r) => (r.id === id ? snap : r));
      }
      if (mobileVialSnapshot) {
        const snap = mobileVialSnapshot;
        vialTrackingRows = vialTrackingRows.map((r) => (r.vialId === id ? snap : r));
      }
    }
    mobileEditId = null;
    mobileMedSnapshot = null;
    mobileVialSnapshot = null;
  }
  function confirmVialDelete() {
    const id = vialDeleteRequest;
    vialDeleteRequest = null;
    // Clear edit state so the delete's scheduleMedSave isn't suppressed.
    mobileEditId = null;
    mobileMedSnapshot = null;
    mobileVialSnapshot = null;
    if (id != null) deleteMedicationRow(id);
  }

  // ── Auto-save ──────────────────────────────────────────────────────────────
  // Reuse the existing save-all (`commitVialOrder`, debounced) so every edit /
  // structural change persists without an explicit save button. The persistence
  // logic is unchanged — only *when* it runs.
  let medSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleMedSave() {
    // While a mobile card is open, edits are buffered — only its Save button
    // persists (it clears mobileEditId first, so this guard then passes).
    if (mobileEditingActive) return;
    if (medSaveTimer) clearTimeout(medSaveTimer);
    medSaveTimer = setTimeout(() => {
      // Defer while a cell is actively being edited — `commitVialOrder` rebuilds
      // the row objects, which would otherwise disrupt an in-progress edit in
      // another cell. Retry shortly; the editor's commit/blur fires another
      // schedule once editing ends.
      if (dosageGrid.editing || vialGrid.editing) {
        scheduleMedSave();
        return;
      }
      medSaveTimer = undefined;
      void commitVialOrder();
    }, 400);
  }

  // ── Spreadsheet selection for the two tables (shared engine) ────────────────
  // Each cell is two-state (display → editor on click/Enter); arrows navigate,
  // Tab leaves the grid, commit auto-saves. One controller per table.
  const dosageGrid = new GridSelection({
    rowCount: () => displayedMedicationInputRows.length,
    colCount: () => activeDosageCols.length,
    isEditable: () => true,
    cellRef: (r, c) =>
      medTableCardRegion?.querySelector<HTMLElement>(`[data-dose-cell="${r}-${c}"]`) ?? null,
    commit: () => scheduleMedSave(),
    stickyTopSelector: '.tabbar',
  });
  const vialGrid = new GridSelection({
    rowCount: () => displayedVialTrackingRows.length,
    colCount: () => activeVialCols.length,
    isEditable: () => true,
    cellRef: (r, c) =>
      medTableCardRegion?.querySelector<HTMLElement>(`[data-vial-cell="${r}-${c}"]`) ?? null,
    commit: () => scheduleMedSave(),
    stickyTopSelector: '.tabbar',
  });

  // ── Computed vial levels (doses / mg left) ────────────────────────────────
  // The remaining column is derived, not stored: capacity (concentration × mL)
  // minus what's been drawn, attributed compound-date FIFO across a medication's
  // vials, with a per-vial manual correction. Computed from the *current* rows
  // (so editing concentration/mL/dose updates it live) plus the logged doses.
  const doseEvents = $derived(
    $rawEntries.filter(isConsumingDose).map((e) => ({
      id: e.id,
      medication: e.medication || '',
      amountMg: e.amountMg as number,
      date: e.date,
      createdAt: e.createdAt,
      // Vial levels are driven purely by each dose's stored attribution now
      // (see computeVialLevels); the vial specs below are keyed by `dbId` to match.
      prescriptionId: e.prescriptionId,
    })),
  );
  const compoundDateByVialId = $derived(
    new Map(sourceVialTrackingRows.map((v) => [v.vialId, v.compoundDate || undefined])),
  );
  const computedVialLevels = $derived(
    computeVialLevels(
      sourceMedicationInputRows.map((row, index) => ({
        // Key by the prescription id so each dose's stored `prescriptionId`
        // attribution matches; unsaved rows fall back to a synthetic id.
        id: row.dbId || `unsaved:${row.id}`,
        medication: row.type || '',
        concentrationMgMl: row.concentrationMg,
        vialMl: row.mlInVial,
        prescribedDoseMg: row.prescribedDosage,
        compoundDate: compoundDateByVialId.get(row.id),
        sortOrder: index,
        createdAt: '',
        manualMgUsed: row.manualMgUsed,
      })),
      doseEvents,
    ),
  );
  function levelOf(row: MedicationInputRow): VialLevel | undefined {
    return computedVialLevels.get(row.dbId || `unsaved:${row.id}`);
  }
  /** Remaining in the active unit, or null when specs are incomplete. */
  function remainingValue(row: MedicationInputRow): number | null {
    const lvl = levelOf(row);
    if (!lvl || lvl.mgCapacity == null) return null;
    if ($vialUnit === 'mg') return lvl.mgLeftClamped ?? 0;
    return lvl.dosesLeft; // null when no prescribed dose size
  }
  function remainingDisplay(row: MedicationInputRow): string {
    const v = remainingValue(row);
    if (v == null) return '—';
    return $vialUnit === 'mg' ? fmtNum(v, 1) : formatDoses(v);
  }
  function isVialEmpty(row: MedicationInputRow): boolean {
    const lvl = levelOf(row);
    return !!lvl && lvl.mgCapacity != null && (lvl.mgLeftClamped ?? 0) <= 0;
  }
  function isVialOver(row: MedicationInputRow): boolean {
    return !!levelOf(row)?.over;
  }
  /** Commit a typed "remaining" as a manual correction (back-solved to mg used). */
  function setRemainingOverride(row: MedicationInputRow, raw: string) {
    // Clearing the cell removes the manual correction and reverts to auto-calc.
    if (raw.trim() === '') {
      medicationInputRows = medicationInputRows.map((r) =>
        r.id === row.id ? { ...r, manualMgUsed: undefined } : r,
      );
      scheduleMedSave();
      return;
    }
    const lvl = levelOf(row);
    const capacity = row.concentrationMg * row.mlInVial;
    if (!(capacity > 0)) return;
    const entered = Number(raw);
    if (!Number.isFinite(entered)) return;
    const desiredMg =
      $vialUnit === 'mg'
        ? entered
        : row.prescribedDosage > 0
          ? entered * row.prescribedDosage
          : NaN;
    if (!Number.isFinite(desiredMg)) return; // doses entry needs a dose size
    const manual = manualMgUsedForDesiredLeft(capacity, lvl?.mgUsedFromDoses ?? 0, desiredMg);
    medicationInputRows = medicationInputRows.map((r) =>
      r.id === row.id ? { ...r, manualMgUsed: manual } : r,
    );
    scheduleMedSave();
  }
  /**
   * Editing a vial's concentration / mL / dose changes what the vial *is*, so a
   * manual remaining-override set against the old specs is stale — drop it and
   * fall back to the auto-calculation (the user can re-enter one if needed).
   * Without this, the stored mg offset would silently shift the remaining when
   * capacity changes.
   */
  function clearOverrideOnSpecEdit(row: MedicationInputRow) {
    if (row.manualMgUsed !== undefined) {
      medicationInputRows = medicationInputRows.map((r) =>
        r.id === row.id ? { ...r, manualMgUsed: undefined } : r,
      );
    }
  }

  // Patch one field of a medication/vial row and schedule an auto-save. Used by
  // the two-state cell editors.
  function setMedField<K extends keyof MedicationInputRow>(
    id: number,
    field: K,
    value: MedicationInputRow[K],
  ) {
    medicationInputRows = medicationInputRows.map((r) =>
      r.id === id ? { ...r, [field]: value } : r,
    );
    scheduleMedSave();
  }
  function setVialField<K extends keyof VialTrackingRow>(
    vialId: number,
    field: K,
    value: VialTrackingRow[K],
  ) {
    vialTrackingRows = vialTrackingRows.map((r) =>
      r.vialId === vialId ? { ...r, [field]: value } : r,
    );
    scheduleMedSave();
  }

  /** Computed doses-left for a saved prescription (store map), with a fallback. */
  function dosesLeftForPrescription(p: Prescription): number {
    const lvl = $vialLevels.get(p.id);
    if (lvl && lvl.dosesLeft != null) return lvl.dosesLeft;
    return p.dosesLeft ?? 0;
  }
  let syncedPrescriptions = $state.raw<Prescription[] | null>(null);
  let colSettingsLoaded = $state(false);
  let lastNotifiedUnsavedChanges = false;
  let draftBaseDosageCols = $state<TableColumn<DosageColKey>[]>([...DEFAULT_DOSAGE_COLS]);
  let draftBaseVialTrackingCols = $state<TableColumn<VialColKey>[]>([...DEFAULT_VIAL_COLS]);
  let lastDiscardSignal = getInitialDiscardSignal();
  const draftBaseHiddenDosageCols = new SvelteSet<DosageColKey>();
  const draftBaseHiddenVialCols = new SvelteSet<VialColKey>();
  let localDosageColumnSettingsChanged = false;
  let localVialColumnSettingsChanged = false;
  let localShowArchivedChanged = false;

  function cloneMedicationRow(row: MedicationInputRow): MedicationInputRow {
    return { ...row };
  }

  function cloneVialRow(row: VialTrackingRow): VialTrackingRow {
    return { ...row };
  }

  function getInitialDiscardSignal(): number {
    return discardSignal;
  }

  function copySet<Key extends string>(target: SvelteSet<Key>, source: Iterable<Key>) {
    target.clear();
    for (const item of source) target.add(item);
  }

  let pendingDosageColumnSettingsSave = Promise.resolve();
  let pendingVialColumnSettingsSave = Promise.resolve();

  function syncSavedDosageColumnSettings(cols: TableColumn<DosageColKey>[], hidden: Iterable<DosageColKey>) {
    savedDosageCols = cols.map((column) => ({ ...column }));
    draftBaseDosageCols = cols.map((column) => ({ ...column }));
    copySet(savedHiddenDosageCols, hidden);
    copySet(draftBaseHiddenDosageCols, hidden);
  }

  function syncSavedVialColumnSettings(cols: TableColumn<VialColKey>[], hidden: Iterable<VialColKey>) {
    savedVialTrackingCols = cols.map((column) => ({ ...column }));
    draftBaseVialTrackingCols = cols.map((column) => ({ ...column }));
    copySet(savedHiddenVialCols, hidden);
    copySet(draftBaseHiddenVialCols, hidden);
  }

  function persistDosageColumnSettings() {
    localDosageColumnSettingsChanged = true;
    const nextCols = dosageCols.map((column) => ({ ...column }));
    const nextHidden = [...hiddenDosageCols];
    syncSavedDosageColumnSettings(nextCols, nextHidden);

    pendingDosageColumnSettingsSave = pendingDosageColumnSettingsSave
      .catch(() => undefined)
      .then(() =>
        saveProfile({
          dosageColOrder: nextCols.map((column) => column.key),
          dosageHiddenCols: nextHidden,
        }),
      )
      .catch((err) => console.error('Failed to save dosage column settings:', err));
  }

  function persistVialColumnSettings() {
    localVialColumnSettingsChanged = true;
    const nextCols = vialTrackingCols.map((column) => ({ ...column }));
    const nextHidden = [...hiddenVialCols];
    syncSavedVialColumnSettings(nextCols, nextHidden);

    pendingVialColumnSettingsSave = pendingVialColumnSettingsSave
      .catch(() => undefined)
      .then(() =>
        saveProfile({
          vialColOrder: nextCols.map((column) => column.key),
          vialHiddenCols: nextHidden,
        }),
      )
      .catch((err) => console.error('Failed to save vial column settings:', err));
  }

  function markRowsAsBaseline() {
    draftBaseMedicationInputRows = medicationInputRows.map(cloneMedicationRow);
    draftBaseVialTrackingRows = vialTrackingRows.map(cloneVialRow);
  }

  function markDosageColumnsAsBaseline() {
    draftBaseDosageCols = dosageCols.map((column) => ({ ...column }));
    copySet(draftBaseHiddenDosageCols, hiddenDosageCols);
  }

  function markVialColumnsAsBaseline() {
    draftBaseVialTrackingCols = vialTrackingCols.map((column) => ({ ...column }));
    copySet(draftBaseHiddenVialCols, hiddenVialCols);
  }

  function rowsMatch(left: unknown[], right: unknown[]): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function dosageComparableRows(rows: MedicationInputRow[]) {
    return rows.map((row) => ({
      dbId: row.dbId,
      type: row.type,
      concentrationMg: row.concentrationMg,
      additive: row.additive,
      mlInVial: row.mlInVial,
      prescribedDosage: row.prescribedDosage,
      dosesLeft: row.dosesLeft,
      manualMgUsed: row.manualMgUsed,
      status: row.status,
    }));
  }

  function vialComparableRows(vialRows: VialTrackingRow[], medicationRows: MedicationInputRow[]) {
    return vialRows.map((row) => {
      const medicationRow = medicationRows.find((item) => item.id === row.vialId);
      return {
        dbId: row.dbId,
        compoundDate: row.compoundDate,
        bud: row.bud,
        lotNumber: row.lotNumber,
        pharmacy: medicationRow?.pharmacy ?? '',
        cost: medicationRow?.cost ?? 0,
      };
    });
  }


  $effect(() => {
    if (colSettingsLoaded) return;
    colSettingsLoaded = true;
    void getProfile().then((profile) => {
      const dosageKeys = new Set(DEFAULT_DOSAGE_COLS.map((c) => c.key));
      let nextDosageCols = [...DEFAULT_DOSAGE_COLS];
      if (profile?.dosageColOrder?.length === DEFAULT_DOSAGE_COLS.length) {
        const order = profile.dosageColOrder.filter((k): k is DosageColKey => dosageKeys.has(k as DosageColKey));
        if (order.length === DEFAULT_DOSAGE_COLS.length) {
          nextDosageCols = order.map((k) => DEFAULT_DOSAGE_COLS.find((c) => c.key === k)!);
        }
      }
      const nextHiddenDosageCols = (profile?.dosageHiddenCols ?? []).filter((key): key is DosageColKey =>
        dosageKeys.has(key as DosageColKey),
      );
      if (!localDosageColumnSettingsChanged) {
        savedDosageCols = nextDosageCols.map((column) => ({ ...column }));
        copySet(savedHiddenDosageCols, nextHiddenDosageCols);
        dosageCols = nextDosageCols.map((column) => ({ ...column }));
        copySet(hiddenDosageCols, nextHiddenDosageCols);
        markDosageColumnsAsBaseline();
      }

      const vialKeys = new Set(DEFAULT_VIAL_COLS.map((c) => c.key));
      let nextVialCols = [...DEFAULT_VIAL_COLS];
      if (profile?.vialColOrder?.length === DEFAULT_VIAL_COLS.length) {
        const order = profile.vialColOrder.filter((k): k is VialColKey => vialKeys.has(k as VialColKey));
        if (order.length === DEFAULT_VIAL_COLS.length) {
          nextVialCols = order.map((k) => DEFAULT_VIAL_COLS.find((c) => c.key === k)!);
        }
      }
      const nextHiddenVialCols = (profile?.vialHiddenCols ?? []).filter((key): key is VialColKey =>
        vialKeys.has(key as VialColKey),
      );
      if (!localVialColumnSettingsChanged) {
        savedVialTrackingCols = nextVialCols.map((column) => ({ ...column }));
        copySet(savedHiddenVialCols, nextHiddenVialCols);
        vialTrackingCols = nextVialCols.map((column) => ({ ...column }));
        copySet(hiddenVialCols, nextHiddenVialCols);
        markVialColumnsAsBaseline();
      }

      if (!localShowArchivedChanged) {
        showArchivedVials = profile?.showArchivedVials ?? false;
      }
    });
  });

  function medicationRowsFromPrescriptions(prescriptions: Prescription[]): MedicationInputRow[] {
    return prescriptions.map((p, i) => ({
      id: i + 1,
      dbId: p.id,
      type: p.type ?? '',
      cost: p.costUsd ?? 0,
      pharmacy: p.pharmacy ?? '',
      concentrationMg: p.concentrationMgMl ?? 0,
      additive: p.additive ?? '',
      mlInVial: p.vialMl ?? 0,
      prescribedDosage: p.prescribedDoseMg ?? 0,
      dosesLeft: p.dosesLeft ?? 0,
      manualMgUsed: p.manualMgUsed,
      status: p.status ?? 'neutral',
      archived: p.archived ?? false,
    }));
  }

  function vialRowsFromPrescriptions(prescriptions: Prescription[]): VialTrackingRow[] {
    return prescriptions.map((p, i) => ({
      vialId: i + 1,
      dbId: p.id,
      compoundDate: p.compoundDate ?? '',
      bud: p.bud ?? '',
      lotNumber: p.lotNumber ?? '',
    }));
  }

  $effect(() => {
    const prescriptions = $rawPrescriptions;
    if (prescriptions === syncedPrescriptions) return;
    syncedPrescriptions = prescriptions;

    const nextMedicationRows = medicationRowsFromPrescriptions(prescriptions);
    const nextVialRows = vialRowsFromPrescriptions(prescriptions);
    const draftHasRowChanges =
      !rowsMatch(dosageComparableRows(medicationInputRows), dosageComparableRows(draftBaseMedicationInputRows)) ||
      !rowsMatch(vialComparableRows(vialTrackingRows, medicationInputRows), vialComparableRows(draftBaseVialTrackingRows, draftBaseMedicationInputRows));

    savedMedicationInputRows = nextMedicationRows.map(cloneMedicationRow);
    savedVialTrackingRows = nextVialRows.map(cloneVialRow);

    if (!draftHasRowChanges) {
      medicationInputRows = nextMedicationRows.map(cloneMedicationRow);
      vialTrackingRows = nextVialRows.map(cloneVialRow);
      markRowsAsBaseline();
    }
  });

  $effect(() => {
    if (active) return;
    settingsOpen = false;
  });

  // Auto-save: tables persist continuously now, so never report unsaved changes
  // to the parent (no navigation-away warning for the always-saved tables).
  $effect(() => {
    if (lastNotifiedUnsavedChanges) return;
    lastNotifiedUnsavedChanges = true;
    onUnsavedChange?.(false);
  });

  $effect(() => {
    if (discardSignal === lastDiscardSignal) return;
    lastDiscardSignal = discardSignal;
    discardMedicationEdits();
  });

  const totalSpend = $derived.by<number | null>(() => {
    let sum = 0;
    let hasAny = false;
    for (const p of $rawPrescriptions) {
      if (typeof p.costUsd === 'number' && Number.isFinite(p.costUsd)) {
        sum += p.costUsd;
        hasAny = true;
      }
    }
    return hasAny ? sum : null;
  });
  const lbsLost = $derived(
    $startWeight != null && $currentWeight != null
      ? Math.max($startWeight - $currentWeight, 0)
      : null,
  );
  const displayLost = $derived(
    lbsLost != null ? displayWeight(String(lbsLost), $weightUnit) : null,
  );
  const costPerUnit = $derived(
    totalSpend != null && lbsLost != null && lbsLost > 0
      ? totalSpend / lbsLost
      : null,
  );

  // ── Reminders ──────────────────────────────────────────────────────────────
  // Assume weekly cadence: 4 doses ≈ 1 month of supply.
  const REFILL_THRESHOLD_DOSES = 4;
  const BUD_WARNING_DAYS = 30;

  const todayKey = $derived(localDateKey());

  type BudReminder = { dbId: string; vialNumber: number; type: string; bud: string; daysUntilBud: number };
  type RefillReminder = { type: string; dosesLeft: number };

  const budReminders = $derived.by<BudReminder[]>(() =>
    $rawPrescriptions
      .map((p, i) => ({ p, vialNumber: i + 1 }))
      .filter(({ p }) => dosesLeftForPrescription(p) > 0 && !!p.bud && p.bud > todayKey && p.bud <= addDays(todayKey, BUD_WARNING_DAYS))
      .map(({ p, vialNumber }) => ({
        dbId: p.id,
        vialNumber,
        type: p.type ?? '',
        bud: p.bud!,
        daysUntilBud: daysBetween(todayKey, p.bud!),
      }))
      .sort((a, b) => a.daysUntilBud - b.daysUntilBud),
  );

  const refillReminders = $derived.by<RefillReminder[]>(() => {
    const supplyByType = new Map<string, number>();
    for (const p of $rawPrescriptions) {
      if (!p.type) continue;
      const doses = dosesLeftForPrescription(p);
      if (doses <= 0) continue;
      if (p.bud && p.bud <= todayKey) continue;
      supplyByType.set(p.type, (supplyByType.get(p.type) ?? 0) + doses);
    }
    return [...supplyByType.entries()]
      .filter(([, count]) => count < REFILL_THRESHOLD_DOSES)
      .map(([type, dosesLeft]) => ({ type, dosesLeft }))
      .sort((a, b) => a.dosesLeft - b.dosesLeft);
  });

  // BUD dismissal is keyed on (dbId, bud); editing the BUD date re-fires the reminder.
  const visibleBudReminders = $derived(
    budReminders.filter((r) => {
      const entry = $dismissedReminders.bud[r.dbId];
      return !entry || entry.bud !== r.bud;
    }),
  );
  // Refill dismissal is keyed on (type, dose count at dismissal); a further dip re-fires.
  const visibleRefillReminders = $derived(
    refillReminders.filter((r) => {
      const entry = $dismissedReminders.refill[r.type];
      return !entry || r.dosesLeft < entry.atDoses;
    }),
  );
  const hasReminders = $derived(visibleBudReminders.length > 0 || visibleRefillReminders.length > 0);
  const hiddenReminderCount = $derived(
    (budReminders.length - visibleBudReminders.length) +
      (refillReminders.length - visibleRefillReminders.length),
  );

  // Reconcile persisted dismissals against current data: drop entries whose
  // prescription is gone, and clear refill dismissals once supply recovers
  // above the threshold so the next dip re-fires.
  const refillSupplyByType = $derived.by(() => {
    const m = new Map<string, number>();
    for (const p of $rawPrescriptions) {
      if (!p.type) continue;
      const doses = dosesLeftForPrescription(p);
      if (doses <= 0) continue;
      if (p.bud && p.bud <= todayKey) continue;
      m.set(p.type, (m.get(p.type) ?? 0) + doses);
    }
    return m;
  });
  const knownPrescriptionIds = $derived(new Set($rawPrescriptions.map((p) => p.id)));
  $effect(() => {
    dismissedReminders.reconcile({
      knownPrescriptionIds,
      refillSupplyByType,
      refillThreshold: REFILL_THRESHOLD_DOSES,
    });
  });

  function shortDrugName(name: string): string {
    const generic = name.split('(')[0]?.trim();
    return generic || name;
  }

  function formatDoses(doses: number): string {
    return Number.isInteger(doses) ? String(doses) : doses.toFixed(1);
  }

  function calculatedCostPerMg(row: MedicationInputRow) {
    const totalMg = row.concentrationMg * row.mlInVial;
    if (!totalMg) return 0;
    return row.cost / totalMg;
  }

  const activeVialId = $derived(
    displayedMedicationInputRows.filter((r) => !isVialEmpty(r)).sort((a, b) => a.id - b.id)[0]?.id ?? null
  );

  const concentrationDecimals = $derived(
    columnDecimals(displayedMedicationInputRows.map((r) => r.concentrationMg))
  );
  const prescribedDosageDecimals = $derived(
    columnDecimals(displayedMedicationInputRows.map((r) => r.prescribedDosage))
  );

  function vialStatusClass(row: MedicationInputRow) {
    if (row.id === activeVialId) return 'vial-status-active';
    if (isVialEmpty(row)) return 'vial-status-warning';
    return 'vial-status-neutral';
  }

  function formatCurrency(value: number | null | undefined) {
    const normalized =
      typeof value === 'number' ? value : Number(value ?? Number.NaN);

    if (!Number.isFinite(normalized)) {
      return '$0.00';
    }

    return `$${normalized.toFixed(2)}`;
  }

  function deleteMedicationRow(id: number) {
    medicationInputRows = medicationInputRows.filter((r) => r.id !== id);
    vialTrackingRows = vialTrackingRows.filter((r) => r.vialId !== id);
    scheduleMedSave();
  }

  function addMedicationRow() {
    const newId = Math.max(...medicationInputRows.map((r) => r.id), 0) + 1;
    medicationInputRows = [
      ...medicationInputRows,
      { id: newId, dbId: '', type: '', cost: 0, pharmacy: '', concentrationMg: 0, additive: '', mlInVial: 0, prescribedDosage: 0, dosesLeft: 0, status: 'neutral', archived: false },
    ];
    syncTrackingRowsToInputOrder();
    // On mobile open the fresh vial card in edit mode so all fields are ready to
    // fill (this also buffers it — it persists when the user taps Save).
    if ($isMobile) startMobileEdit(newId);
    scheduleMedSave();
  }

  function reorderVisibleColumns<Key extends string>(
    cols: TableColumn<Key>[],
    hiddenCols: SvelteSet<Key>,
    from: number,
    to: number,
  ): TableColumn<Key>[] {
    if (from === to) return cols;
    const visibleCols = cols.filter((col) => !hiddenCols.has(col.key));
    if (!visibleCols[from] || !visibleCols[to]) return cols;

    const [moved] = visibleCols.splice(from, 1);
    visibleCols.splice(to, 0, moved);

    let visibleIndex = 0;
    return cols.map((col) => (hiddenCols.has(col.key) ? col : visibleCols[visibleIndex++]));
  }

  function reorderDosageCols(from: number, to: number) {
    if (!dosageSettingsActive) return;
    const nextCols = reorderVisibleColumns(dosageCols, hiddenDosageCols, from, to);
    if (nextCols === dosageCols) return;
    dosageCols = nextCols;
    persistDosageColumnSettings();
  }

  function reorderVialCols(from: number, to: number) {
    if (!vialSettingsActive) return;
    const nextCols = reorderVisibleColumns(vialTrackingCols, hiddenVialCols, from, to);
    if (nextCols === vialTrackingCols) return;
    vialTrackingCols = nextCols;
    persistVialColumnSettings();
  }

  function reorderMedicationRows(from: number, to: number) {
    if (from === to) return;
    const rows = [...medicationInputRows];
    const [moved] = rows.splice(from, 1);
    rows.splice(from < to ? to - 1 : to, 0, moved);
    medicationInputRows = rows;
    syncTrackingRowsToInputOrder();
    scheduleMedSave();
  }

  function reorderVialRows(from: number, to: number) {
    if (from === to) return;
    const rows = [...vialTrackingRows];
    const [moved] = rows.splice(from, 1);
    rows.splice(from < to ? to - 1 : to, 0, moved);
    vialTrackingRows = rows;
    medicationInputRows = [...rows]
      .map((trackingRow) =>
        medicationInputRows.find((inputRow) => inputRow.id === trackingRow.vialId)
      )
      .filter((row): row is MedicationInputRow => Boolean(row));
    scheduleMedSave();
  }

  async function commitVialOrder() {
    const rowsWithTracking = medicationInputRows.map((inputRow) => ({
      inputRow,
      trackingRow:
        vialTrackingRows.find((trackingRow) => trackingRow.vialId === inputRow.id) ?? {
          vialId: inputRow.id,
          dbId: inputRow.dbId,
          compoundDate: '',
          bud: '',
          lotNumber: '',
        },
    }));

    const normalizedInputRows = rowsWithTracking.map(({ inputRow }, index) => ({
      ...inputRow,
      id: index + 1,
    }));
    const normalizedVialRows = rowsWithTracking.map(({ trackingRow }, index) => ({
      ...trackingRow,
      vialId: index + 1,
    }));
    const savedDbIds = new Set(savedMedicationInputRows.map((row) => row.dbId).filter(Boolean));
    const keptDbIds = new Set(normalizedInputRows.map((row) => row.dbId).filter(Boolean));

    for (const dbId of savedDbIds) {
      if (!keptDbIds.has(dbId)) await deletePrescription(dbId);
    }

    for (const [index, row] of normalizedInputRows.entries()) {
      const vial = normalizedVialRows[index];
      const payload = {
        type: row.type === '' ? undefined : row.type,
        costUsd: row.cost,
        pharmacy: row.pharmacy,
        concentrationMgMl: row.concentrationMg,
        additive: row.additive,
        vialMl: row.mlInVial,
        prescribedDoseMg: row.prescribedDosage,
        // `dosesLeft` is now derived (see vialLevels); persist only the manual
        // correction the user typed into the remaining cell, if any.
        manualMgUsed: row.manualMgUsed,
        status: row.status,
        compoundDate: vial?.compoundDate || undefined,
        bud: vial?.bud || undefined,
        lotNumber: vial?.lotNumber,
        sortOrder: index,
      };

      if (row.dbId) {
        await updatePrescription(row.dbId, payload);
      } else {
        const created = await addPrescription(payload);
        row.dbId = created.id;
        if (vial) vial.dbId = created.id;
      }
    }

    medicationInputRows = normalizedInputRows.map(cloneMedicationRow);
    vialTrackingRows = normalizedVialRows.map(cloneVialRow);
    savedMedicationInputRows = medicationInputRows.map(cloneMedicationRow);
    savedVialTrackingRows = vialTrackingRows.map(cloneVialRow);
    markRowsAsBaseline();
  }

  function toggleSettings() {
    settingsOpen = !settingsOpen;
    if (!settingsOpen) {
      resetDosageColumnInteractionState();
      resetVialColumnInteractionState();
    }
  }

  // Revert any in-flight (not-yet-autosaved) edits to the last saved baseline.
  function discardMedicationEdits() {
    medicationInputRows = savedMedicationInputRows.map(cloneMedicationRow);
    vialTrackingRows = savedVialTrackingRows.map(cloneVialRow);
    markRowsAsBaseline();
    settingsOpen = false;
  }

  function resetDosageTable() {
    if (!confirm('Reset the Dosage table to its default column order and visibility?')) return;
    dosageCols = [...DEFAULT_DOSAGE_COLS];
    hiddenDosageCols.clear();
    resetDosageColumnInteractionState();
    persistDosageColumnSettings();
  }

  function resetVialTable() {
    if (!confirm('Reset the Vial Tracking table to its default column order and visibility?')) return;
    vialTrackingCols = [...DEFAULT_VIAL_COLS];
    hiddenVialCols.clear();
    resetVialColumnInteractionState();
    persistVialColumnSettings();
  }

  function dosageColumnLabel(column: DosageColKey): string {
    return dosageCols.find((col) => col.key === column)?.label ?? column;
  }

  function vialColumnLabel(column: VialColKey): string {
    return vialTrackingCols.find((col) => col.key === column)?.label ?? column;
  }

  function resetDosageColumnInteractionState() {
    dosageColDragIndex = null;
    dosageColDragoverIndex = null;
    dosageColKbIndex = null;
  }

  function resetVialColumnInteractionState() {
    vialColDragIndex = null;
    vialColDragoverIndex = null;
    vialColKbIndex = null;
  }

  function hideDosageColumn(column: DosageColKey) {
    if (hiddenDosageCols.has(column)) return;
    hiddenDosageCols.add(column);
    resetDosageColumnInteractionState();
    persistDosageColumnSettings();
    void announce(`${dosageColumnLabel(column)} column hidden.`);
  }

  function showDosageColumn(column: DosageColKey) {
    if (!hiddenDosageCols.has(column)) return;
    hiddenDosageCols.delete(column);
    persistDosageColumnSettings();
    void announce(`${dosageColumnLabel(column)} column restored.`);
  }

  function hideVialColumn(column: VialColKey) {
    if (hiddenVialCols.has(column)) return;
    hiddenVialCols.add(column);
    resetVialColumnInteractionState();
    persistVialColumnSettings();
    void announce(`${vialColumnLabel(column)} column hidden.`);
  }

  function showVialColumn(column: VialColKey) {
    if (!hiddenVialCols.has(column)) return;
    hiddenVialCols.delete(column);
    persistVialColumnSettings();
    void announce(`${vialColumnLabel(column)} column restored.`);
  }

  function toggleShowArchivedVials() {
    showArchivedVials = !showArchivedVials;
    localShowArchivedChanged = true;
    void saveProfile({ showArchivedVials }).catch((err) =>
      console.error('Failed to save show-archived setting:', err),
    );
  }

  // Archiving is a standalone side-action, not part of the dosage/vial draft:
  // it persists immediately and isn't tracked by the unsaved-change detector
  // (archived is absent from the comparable-row projections). We mirror the
  // flag into every in-memory copy so it survives a pending draft (the
  // prescription $effect won't rebuild medicationInputRows while edits are
  // outstanding) and stays consistent once the live query echoes it back.
  function setVialArchived(id: number, archived: boolean) {
    const row =
      medicationInputRows.find((r) => r.id === id) ??
      savedMedicationInputRows.find((r) => r.id === id);
    if (!row) return;
    const apply = (rows: MedicationInputRow[]) =>
      rows.map((r) => (r.id === id ? { ...r, archived } : r));
    medicationInputRows = apply(medicationInputRows);
    savedMedicationInputRows = apply(savedMedicationInputRows);
    draftBaseMedicationInputRows = apply(draftBaseMedicationInputRows);
    void announce(`Vial ${id} ${archived ? 'archived' : 'restored'}.`);

    if (row.dbId) {
      void updatePrescription(row.dbId, { archived }).catch((err) =>
        console.error('Failed to update vial archived state:', err),
      );
    }
  }

  function syncTrackingRowsToInputOrder() {
    vialTrackingRows = medicationInputRows.map((inputRow) => {
      const existing = vialTrackingRows.find((v) => v.vialId === inputRow.id);
      return existing ?? { vialId: inputRow.id, dbId: inputRow.dbId, compoundDate: '', bud: '', lotNumber: '' };
    });
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

  function kbReorderMedicationRows(from: number, to: number) {
    const rows = [...medicationInputRows];
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    medicationInputRows = rows;
    syncTrackingRowsToInputOrder();
    scheduleMedSave();
  }

  function kbReorderVialRows(from: number, to: number) {
    const rows = [...vialTrackingRows];
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    vialTrackingRows = rows;
    medicationInputRows = [...rows]
      .map((vr) => medicationInputRows.find((ir) => ir.id === vr.vialId))
      .filter((r): r is MedicationInputRow => Boolean(r));
    scheduleMedSave();
  }

  function dosageRowKeydown(e: KeyboardEvent, index: number) {
    if (!editable) return;
    const n = medicationInputRows.length;
    if (e.key === ' ') {
      e.preventDefault();
      if (dosageKbIndex === null) {
        dosageKbIndex = index;
        dosageKbRowId = medicationInputRows[index].id;
        dosageKbSnapshot = [...medicationInputRows];
        void announce(`Grabbed vial ${dosageKbRowId}. Use up and down arrow keys to move, Space to drop, Escape to cancel.`);
      } else {
        void announce(`Dropped. Vial ${dosageKbRowId} is now at position ${dosageKbIndex + 1} of ${n}.`);
        dosageKbIndex = null; dosageKbRowId = null; dosageKbSnapshot = null;
      }
    } else if (e.key === 'Escape' && dosageKbIndex !== null) {
      e.preventDefault();
      medicationInputRows = dosageKbSnapshot!;
      syncTrackingRowsToInputOrder();
      const id = dosageKbRowId;
      dosageKbIndex = null; dosageKbRowId = null; dosageKbSnapshot = null;
      void announce('Cancelled.');
      void focusById(`dosage-row-handle-${id}`);
    } else if (e.key === 'ArrowUp' && dosageKbIndex !== null && dosageKbIndex > 0) {
      e.preventDefault();
      kbReorderMedicationRows(dosageKbIndex, dosageKbIndex - 1);
      dosageKbIndex -= 1;
      void announce(`Vial ${dosageKbRowId}, position ${dosageKbIndex + 1} of ${n}.`);
      void focusById(`dosage-row-handle-${dosageKbRowId}`);
    } else if (e.key === 'ArrowDown' && dosageKbIndex !== null && dosageKbIndex < n - 1) {
      e.preventDefault();
      kbReorderMedicationRows(dosageKbIndex, dosageKbIndex + 1);
      dosageKbIndex += 1;
      void announce(`Vial ${dosageKbRowId}, position ${dosageKbIndex + 1} of ${n}.`);
      void focusById(`dosage-row-handle-${dosageKbRowId}`);
    }
  }

  function vialRowKeydown(e: KeyboardEvent, index: number) {
    if (!editable) return;
    const n = vialTrackingRows.length;
    if (e.key === ' ') {
      e.preventDefault();
      if (vialKbIndex === null) {
        vialKbIndex = index;
        vialKbVialId = vialTrackingRows[index].vialId;
        vialKbSnapshot = { inputRows: [...medicationInputRows], vialRows: [...vialTrackingRows] };
        void announce(`Grabbed vial ${vialKbVialId}. Use up and down arrow keys to move, Space to drop, Escape to cancel.`);
      } else {
        void announce(`Dropped. Vial ${vialKbVialId} is now at position ${vialKbIndex + 1} of ${n}.`);
        vialKbIndex = null; vialKbVialId = null; vialKbSnapshot = null;
      }
    } else if (e.key === 'Escape' && vialKbIndex !== null) {
      e.preventDefault();
      medicationInputRows = vialKbSnapshot!.inputRows;
      vialTrackingRows = vialKbSnapshot!.vialRows;
      const id = vialKbVialId;
      vialKbIndex = null; vialKbVialId = null; vialKbSnapshot = null;
      void announce('Cancelled.');
      void focusById(`vial-row-handle-${id}`);
    } else if (e.key === 'ArrowUp' && vialKbIndex !== null && vialKbIndex > 0) {
      e.preventDefault();
      kbReorderVialRows(vialKbIndex, vialKbIndex - 1);
      vialKbIndex -= 1;
      void announce(`Vial ${vialKbVialId}, position ${vialKbIndex + 1} of ${n}.`);
      void focusById(`vial-row-handle-${vialKbVialId}`);
    } else if (e.key === 'ArrowDown' && vialKbIndex !== null && vialKbIndex < n - 1) {
      e.preventDefault();
      kbReorderVialRows(vialKbIndex, vialKbIndex + 1);
      vialKbIndex += 1;
      void announce(`Vial ${vialKbVialId}, position ${vialKbIndex + 1} of ${n}.`);
      void focusById(`vial-row-handle-${vialKbVialId}`);
    }
  }

  function dosageColKeydown(e: KeyboardEvent, index: number) {
    if (!dosageSettingsActive) return;
    const n = activeDosageCols.length;
    const activeCol = activeDosageCols[index];
    if (!activeCol) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (dosageColKbIndex === null) {
        dosageColKbIndex = index;
        void announce(`Grabbed ${activeCol.label} column. Use left and right arrow keys to move, Space to drop, Escape to stop.`);
      } else {
        void announce(`Dropped. ${activeDosageCols[dosageColKbIndex].label} column is now at position ${dosageColKbIndex + 1} of ${n}.`);
        dosageColKbIndex = null;
      }
    } else if (e.key === 'Escape' && dosageColKbIndex !== null) {
      e.preventDefault();
      const key = activeDosageCols[dosageColKbIndex].key;
      dosageColKbIndex = null;
      void announce('Stopped column reordering.');
      void focusById(`dosage-col-handle-${key}`);
    } else if (e.key === 'ArrowLeft' && dosageColKbIndex !== null && dosageColKbIndex > 0) {
      e.preventDefault();
      reorderDosageCols(dosageColKbIndex, dosageColKbIndex - 1);
      dosageColKbIndex -= 1;
      void announce(`${activeDosageCols[dosageColKbIndex].label} column, position ${dosageColKbIndex + 1} of ${n}.`);
      void focusById(`dosage-col-handle-${activeDosageCols[dosageColKbIndex].key}`);
    } else if (e.key === 'ArrowRight' && dosageColKbIndex !== null && dosageColKbIndex < n - 1) {
      e.preventDefault();
      reorderDosageCols(dosageColKbIndex, dosageColKbIndex + 1);
      dosageColKbIndex += 1;
      void announce(`${activeDosageCols[dosageColKbIndex].label} column, position ${dosageColKbIndex + 1} of ${n}.`);
      void focusById(`dosage-col-handle-${activeDosageCols[dosageColKbIndex].key}`);
    }
  }

  function vialColKeydown(e: KeyboardEvent, index: number) {
    if (!vialSettingsActive) return;
    const n = activeVialCols.length;
    const activeCol = activeVialCols[index];
    if (!activeCol) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (vialColKbIndex === null) {
        vialColKbIndex = index;
        void announce(`Grabbed ${activeCol.label} column. Use left and right arrow keys to move, Space to drop, Escape to stop.`);
      } else {
        void announce(`Dropped. ${activeVialCols[vialColKbIndex].label} column is now at position ${vialColKbIndex + 1} of ${n}.`);
        vialColKbIndex = null;
      }
    } else if (e.key === 'Escape' && vialColKbIndex !== null) {
      e.preventDefault();
      const key = activeVialCols[vialColKbIndex].key;
      vialColKbIndex = null;
      void announce('Stopped column reordering.');
      void focusById(`vial-col-handle-${key}`);
    } else if (e.key === 'ArrowLeft' && vialColKbIndex !== null && vialColKbIndex > 0) {
      e.preventDefault();
      reorderVialCols(vialColKbIndex, vialColKbIndex - 1);
      vialColKbIndex -= 1;
      void announce(`${activeVialCols[vialColKbIndex].label} column, position ${vialColKbIndex + 1} of ${n}.`);
      void focusById(`vial-col-handle-${activeVialCols[vialColKbIndex].key}`);
    } else if (e.key === 'ArrowRight' && vialColKbIndex !== null && vialColKbIndex < n - 1) {
      e.preventDefault();
      reorderVialCols(vialColKbIndex, vialColKbIndex + 1);
      vialColKbIndex += 1;
      void announce(`${activeVialCols[vialColKbIndex].label} column, position ${vialColKbIndex + 1} of ${n}.`);
      void focusById(`vial-col-handle-${activeVialCols[vialColKbIndex].key}`);
    }
  }

</script>

<!-- Mobile-only per-card controls, rendered in the card's header ("Vial N") row
     (display:none on desktop). Shared by the Dosage and Vial tabs since a vial
     card on either tab edits the same vial: pencil (read) ↔ Save/Cancel/Archive/
     Delete (edit). -->
{#snippet cardActions(id: number)}
  {@const archived = getMedRowById(id)?.archived ?? false}
  <span class="card-header-actions">
    {#if isRowMobileEditing(id)}
      <button type="button" class="card-action-btn card-save" aria-label="Save" title="Save" onclick={saveMobileEdit}><SaveIcon size="1.1rem" /></button>
      <button type="button" class="card-action-btn card-cancel" onclick={cancelMobileEdit}>Cancel</button>
      {#if vialArchivable(id)}
        <button type="button" class="card-action-btn card-archive" aria-label={archived ? 'Restore' : 'Archive'} title={archived ? 'Restore' : 'Archive'} onclick={() => setVialArchived(id, !archived)}><ArchiveIcon size="1.15rem" /></button>
      {/if}
      <button type="button" class="card-action-btn card-delete" aria-label="Delete" title="Delete" onclick={() => (vialDeleteRequest = id)}><TrashIcon size="1.15rem" /></button>
    {:else}
      <EditPencil ariaLabel={`Edit vial ${id}`} onclick={() => startMobileEdit(id)} />
    {/if}
  </span>
{/snippet}

<main class="content">
  <section class="medication-layout">
    <article class="card med-table-card" bind:this={medTableCardRegion}>
      <div class="chip-row">
        <div class="med-tabs" role="tablist" aria-label="Medication view">
          <button
            type="button"
            role="tab"
            id="med-tab-dosage"
            class="med-tab"
            class:active={activeMedTab === 'dosage'}
            aria-selected={activeMedTab === 'dosage'}
            onclick={() => (activeMedTab = 'dosage')}
          >Dosage</button>
          <button
            type="button"
            role="tab"
            id="med-tab-vial"
            class="med-tab"
            class:active={activeMedTab === 'vial'}
            aria-selected={activeMedTab === 'vial'}
            onclick={() => (activeMedTab = 'vial')}
          >Vial Info</button>
        </div>
        <button
          type="button"
          class="add-row-btn"
          aria-label="Add vial"
          onclick={addMedicationRow}
        >+</button>
        <button
          type="button"
          class="mini-icon"
          class:active={settingsOpen}
          aria-label={settingsOpen ? 'Hide table settings' : 'Show table settings'}
          title={settingsOpen ? 'Hide table settings' : 'Show table settings'}
          aria-pressed={settingsOpen}
          onclick={toggleSettings}
        >
          <GearIcon size="var(--edit-icon-scale)" color="white" />
        </button>
      </div>
      <div class="tab-panel" role="tabpanel" aria-labelledby={activeMedTab === 'dosage' ? 'med-tab-dosage' : 'med-tab-vial'}>
      {#if activeMedTab === 'dosage'}
      {#if dosageSettingsActive}
        <section class="column-manager" aria-label="Dosage hidden columns">
          <fieldset class="hidden-columns-fieldset">
            <legend class="hidden-columns-legend">
              <span>Hidden columns</span>
              <button
                type="button"
                class="legend-reset-btn"
                aria-label="Reset dosage table columns to defaults"
                title="Reset columns"
                onclick={resetDosageTable}
              >↺</button>
            </legend>
            <div class="option-list">
              {#each hiddenDosageColumnOptions as col (col.key)}
                <button
                  type="button"
                  class="option-chip option-chip--restore"
                  aria-label={`Show ${col.label} column`}
                  onclick={() => showDosageColumn(col.key)}
                >
                  <span>{col.label}</span>
                  <span class="restore-mark" aria-hidden="true">+</span>
                </button>
              {/each}
            </div>
          </fieldset>
          <label class="archived-toggle">
            <input type="checkbox" checked={showArchivedVials} onchange={toggleShowArchivedVials} />
            <span>Show archived vials{#if archivedVialCount > 0} ({archivedVialCount}){/if}</span>
          </label>
        </section>
      {/if}
      <div class="table-scroll">
        <table class="inputs-table medication-table">
          <thead>
            <tr>
              <th>Vial</th>
              {#each activeDosageCols as col, colIndex (col.key)}
                <th
                  class:col-type={col.key === 'type'}
                  class:col-narrow={col.key === 'additive' || col.key === 'mlInVial' || col.key === 'dosesLeft'}
                  class:col-dragging={dosageSettingsActive && (dosageColDragIndex === colIndex || dosageColKbIndex === colIndex)}
                  class:col-indicator-left={dosageSettingsActive && dosageColIndicator?.col === colIndex && dosageColIndicator?.side === 'left'}
                  class:col-indicator-right={dosageSettingsActive && dosageColIndicator?.col === colIndex && dosageColIndicator?.side === 'right'}
                  draggable={dosageSettingsActive}
                  ondragstart={(e) => { e.stopPropagation(); dosageColDragIndex = colIndex; }}
                  ondragover={(e) => { e.preventDefault(); e.stopPropagation(); dosageColDragoverIndex = colIndex; }}
                  ondragleave={() => { if (dosageColDragoverIndex === colIndex) dosageColDragoverIndex = null; }}
                  ondrop={(e) => { e.stopPropagation(); if (dosageColDragIndex !== null) reorderDosageCols(dosageColDragIndex, colIndex); dosageColDragIndex = null; dosageColDragoverIndex = null; }}
                  ondragend={() => { dosageColDragIndex = null; dosageColDragoverIndex = null; }}
                >
                  {#if dosageSettingsActive}
                    <div class="th-edit">
                      <button
                        type="button"
                        class="drag-handle"
                        id="dosage-col-handle-{col.key}"
                        aria-roledescription="Drag handle"
                        aria-label="Reorder {col.label} column"
                        aria-pressed={dosageColKbIndex === colIndex}
                        ondragstart={(e) => e.preventDefault()}
                        onkeydown={$isMobile ? undefined : (e) => dosageColKeydown(e, colIndex)}
                      >⠿</button>
                      <span class="th-label">{col.label}</span>
                      <button
                        type="button"
                        class="column-remove-btn"
                        aria-label={`Remove ${col.label} column`}
                        onclick={() => hideDosageColumn(col.key)}
                      >×</button>
                    </div>
                  {:else if col.key === 'dosesLeft'}
                    <button
                      type="button"
                      class="vial-unit-toggle"
                      title="Switch between doses left and mg left"
                      onclick={(e) => { e.stopPropagation(); vialUnit.toggle(); }}
                    >{$vialUnit === 'mg' ? 'mg Left' : 'Doses Left'} ⇄</button>
                  {:else}
                    {col.label}
                  {/if}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each displayedMedicationInputRows as row, displayIndex (row.id)}
              {@const index = sourceMedicationInputRows.findIndex((r) => r.id === row.id)}
              <tr
                class={vialStatusClass(row)}
                class:row-archived={row.archived}
                class:row-dragging={settingsOpen && (dosageDragIndex === index || dosageKbIndex === index)}
                class:row-dragover={settingsOpen && dosageDragoverIndex === index && dosageDragIndex !== index}
                class:mobile-card-editing={isRowMobileEditing(row.id)}
                draggable={settingsOpen}
                ondragstart={() => (dosageDragIndex = index)}
                ondragover={(e) => { e.preventDefault(); dosageDragoverIndex = index; }}
                ondragleave={() => { if (dosageDragoverIndex === index) dosageDragoverIndex = null; }}
                ondrop={() => { if (dosageDragIndex !== null) reorderMedicationRows(dosageDragIndex, index); dosageDragIndex = null; dosageDragoverIndex = null; }}
                ondragend={() => { dosageDragIndex = null; dosageDragoverIndex = null; }}
              >
                <td>
                  <div class="reorder-cell">
                    {#if settingsOpen}
                      <button
                        type="button"
                        class="drag-handle"
                        id="dosage-row-handle-{row.id}"
                        aria-roledescription="Drag handle"
                        aria-label="Reorder vial {row.id}"
                        aria-pressed={dosageKbIndex === index}
                        ondragstart={(e) => e.preventDefault()}
                        onkeydown={(e) => dosageRowKeydown(e, index)}
                      >⠿</button>
                    {/if}
                    <span>{row.id}</span>
                    {#if settingsOpen}
                      {#if row.archived || isVialEmpty(row)}
                        <button
                          type="button"
                          class="archive-btn"
                          class:active={row.archived}
                          aria-label={row.archived ? `Restore vial ${row.id}` : `Archive vial ${row.id}`}
                          aria-pressed={row.archived}
                          title={row.archived ? 'Restore vial' : 'Archive spent vial'}
                          onclick={() => setVialArchived(row.id, !row.archived)}
                        >{row.archived ? '⤒' : '⤓'}</button>
                      {/if}
                      <button
                        type="button"
                        class="delete-btn"
                        aria-label={`Delete vial ${row.id}`}
                        onclick={() => deleteMedicationRow(row.id)}
                      >×</button>
                    {/if}
                  </div>
                  {@render cardActions(row.id)}
                </td>
                {#each activeDosageCols as col, colIndex (col.key)}
                  {@const dEditing = $isMobile ? isRowMobileEditing(row.id) : dosageGrid.isCellEditing(displayIndex, colIndex)}
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <td
                    data-label={col.label}
                    data-dose-cell="{displayIndex}-{colIndex}"
                    class="med-cell"
                    class:col-type={col.key === 'type'}
                    class:col-narrow={col.key === 'additive' || col.key === 'mlInVial' || col.key === 'dosesLeft'}
                    class:col-compact={col.key === 'additive' || col.key === 'mlInVial' || col.key === 'dosesLeft'}
                    class:cell-editing={dEditing && !$isMobile}
                    class:col-indicator-left={dosageSettingsActive && dosageColIndicator?.col === colIndex && dosageColIndicator?.side === 'left'}
                    class:col-indicator-right={dosageSettingsActive && dosageColIndicator?.col === colIndex && dosageColIndicator?.side === 'right'}
                    tabindex={$isMobile ? undefined : dosageGrid.tabIndexFor(displayIndex, colIndex, displayIndex === 0 && colIndex === 0)}
                    onclick={$isMobile ? undefined : () => dosageGrid.selectCell(displayIndex, colIndex, true)}
                    onkeydown={$isMobile ? undefined : (e) => dosageGrid.cellKeydown(e, displayIndex, colIndex)}
                    onfocusin={$isMobile ? undefined : () => { if (dosageGrid.selRow === null) { dosageGrid.selRow = displayIndex; dosageGrid.selCol = colIndex; } }}
                  >
                    {#if col.key === 'type'}
                      {#if !$isMobile || isRowMobileEditing(row.id)}
                      <CustomPicker
                        value={row.type}
                        options={typeOptions}
                        forceOpen={!$isMobile && dEditing}
                        onRequestClose={() => dosageGrid.exitToCell(displayIndex, colIndex)}
                        onSelect={(v) => { setMedField(row.id, 'type', v as Medication | ''); clearOverrideOnSpecEdit(row); }}
                        ariaLabel={`Medication type for vial ${row.id}`}
                      />
                      {:else}
                        {row.type || ''}
                      {/if}
                    {:else if col.key === 'concentration'}
                      {#if dEditing}
                        <input class="med-input" type="number" bind:value={row.concentrationMg} onkeydown={$isMobile ? undefined : dosageGrid.editorKeydown} onblur={() => { clearOverrideOnSpecEdit(row); dosageGrid.stopEditing(); scheduleMedSave(); }} />
                      {:else}{fmtNum(row.concentrationMg, concentrationDecimals)}{/if}
                    {:else if col.key === 'additive'}
                      {#if dEditing}
                        <input class="med-input" type="text" bind:value={row.additive} onkeydown={$isMobile ? undefined : dosageGrid.editorKeydown} onblur={() => { dosageGrid.stopEditing(); scheduleMedSave(); }} />
                      {:else}{row.additive}{/if}
                    {:else if col.key === 'mlInVial'}
                      {#if dEditing}
                        <input class="med-input" type="number" step="0.1" bind:value={row.mlInVial} onkeydown={$isMobile ? undefined : dosageGrid.editorKeydown} onblur={() => { clearOverrideOnSpecEdit(row); dosageGrid.stopEditing(); scheduleMedSave(); }} />
                      {:else}{row.mlInVial}{/if}
                    {:else if col.key === 'prescribedDosage'}
                      {#if dEditing}
                        <input class="med-input" type="number" step="0.1" bind:value={row.prescribedDosage} onkeydown={$isMobile ? undefined : dosageGrid.editorKeydown} onblur={() => { clearOverrideOnSpecEdit(row); dosageGrid.stopEditing(); scheduleMedSave(); }} />
                      {:else}{fmtNum(row.prescribedDosage, prescribedDosageDecimals)}{/if}
                    {:else if col.key === 'dosesLeft'}
                      {#if dEditing}
                        <input
                          class="med-input"
                          type="number"
                          step="0.1"
                          value={remainingValue(row) ?? ''}
                          onkeydown={$isMobile ? undefined : dosageGrid.editorKeydown}
                          onchange={(e) => setRemainingOverride(row, e.currentTarget.value)}
                          onblur={() => dosageGrid.stopEditing()}
                        />
                        {#if isVialOver(row)}<span class="vial-over" title="Used past the labeled fill (overfill)">over</span>{/if}
                      {:else}
                        {remainingDisplay(row)}{#if isVialOver(row)}<span class="vial-over" title="Used past the labeled fill (overfill)"> over</span>{/if}
                      {/if}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
            {#if settingsOpen}
              <tr
                class="drop-sentinel"
                class:drop-sentinel-active={dosageDragoverIndex === medicationInputRows.length && dosageDragIndex !== null}
                ondragover={(e) => { e.preventDefault(); dosageDragoverIndex = medicationInputRows.length; }}
                ondragleave={() => { if (dosageDragoverIndex === medicationInputRows.length) dosageDragoverIndex = null; }}
                ondrop={() => { if (dosageDragIndex !== null) { reorderMedicationRows(dosageDragIndex, medicationInputRows.length); dosageDragIndex = null; dosageDragoverIndex = null; } }}
              >
                <td colspan={activeDosageCols.length + 1}></td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
      {:else}
      {#if vialSettingsActive}
        <section class="column-manager" aria-label="Vial info hidden columns">
          <fieldset class="hidden-columns-fieldset">
            <legend class="hidden-columns-legend">
              <span>Hidden columns</span>
              <button
                type="button"
                class="legend-reset-btn"
                aria-label="Reset vial info table columns to defaults"
                title="Reset columns"
                onclick={resetVialTable}
              >↺</button>
            </legend>
            <div class="option-list">
              {#each hiddenVialColumnOptions as col (col.key)}
                <button
                  type="button"
                  class="option-chip option-chip--restore"
                  aria-label={`Show ${col.label} column`}
                  onclick={() => showVialColumn(col.key)}
                >
                  <span>{col.label}</span>
                  <span class="restore-mark" aria-hidden="true">+</span>
                </button>
              {/each}
            </div>
          </fieldset>
          <label class="archived-toggle">
            <input type="checkbox" checked={showArchivedVials} onchange={toggleShowArchivedVials} />
            <span>Show archived vials{#if archivedVialCount > 0} ({archivedVialCount}){/if}</span>
          </label>
        </section>
      {/if}
      <div class="table-scroll">
        <table class="inputs-table medication-table">
          <thead>
            <tr>
              <th>Vial</th>
              {#each activeVialCols as col, colIndex (col.key)}
                <th
                  class:col-pharmacy={col.key === 'pharmacy'}
                  class:col-narrow={col.key === 'compoundDate' || col.key === 'lotNumber' || col.key === 'costPerMg'}
                  class:col-bud={col.key === 'bud'}
                  class:col-cost={col.key === 'cost'}
                  class:col-dragging={vialSettingsActive && (vialColDragIndex === colIndex || vialColKbIndex === colIndex)}
                  class:col-indicator-left={vialSettingsActive && vialColIndicator?.col === colIndex && vialColIndicator?.side === 'left'}
                  class:col-indicator-right={vialSettingsActive && vialColIndicator?.col === colIndex && vialColIndicator?.side === 'right'}
                  draggable={vialSettingsActive}
                  ondragstart={(e) => { e.stopPropagation(); vialColDragIndex = colIndex; }}
                  ondragover={(e) => { e.preventDefault(); e.stopPropagation(); vialColDragoverIndex = colIndex; }}
                  ondragleave={() => { if (vialColDragoverIndex === colIndex) vialColDragoverIndex = null; }}
                  ondrop={(e) => { e.stopPropagation(); if (vialColDragIndex !== null) reorderVialCols(vialColDragIndex, colIndex); vialColDragIndex = null; vialColDragoverIndex = null; }}
                  ondragend={() => { vialColDragIndex = null; vialColDragoverIndex = null; }}
                >
                  {#if vialSettingsActive}
                    <div class="th-edit">
                      <button
                        type="button"
                        class="drag-handle"
                        id="vial-col-handle-{col.key}"
                        aria-roledescription="Drag handle"
                        aria-label="Reorder {col.label} column"
                        aria-pressed={vialColKbIndex === colIndex}
                        ondragstart={(e) => e.preventDefault()}
                        onkeydown={$isMobile ? undefined : (e) => vialColKeydown(e, colIndex)}
                      >⠿</button>
                      <span class="th-label">{col.label}</span>
                      <button
                        type="button"
                        class="column-remove-btn"
                        aria-label={`Remove ${col.label} column`}
                        onclick={() => hideVialColumn(col.key)}
                      >×</button>
                    </div>
                  {:else}
                    {col.label}
                  {/if}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each displayedVialTrackingRows as row, displayIndex (row.vialId)}
              {@const index = sourceVialTrackingRows.findIndex((r) => r.vialId === row.vialId)}
              {@const medRow = getMedRowById(row.vialId)}
              <tr
                class:row-archived={medRow?.archived}
                class:row-dragging={settingsOpen && (vialDragIndex === index || vialKbIndex === index)}
                class:row-dragover={settingsOpen && vialDragoverIndex === index && vialDragIndex !== index}
                class:mobile-card-editing={isRowMobileEditing(row.vialId)}
                draggable={settingsOpen}
                ondragstart={() => (vialDragIndex = index)}
                ondragover={(e) => { e.preventDefault(); vialDragoverIndex = index; }}
                ondragleave={() => { if (vialDragoverIndex === index) vialDragoverIndex = null; }}
                ondrop={() => { if (vialDragIndex !== null) reorderVialRows(vialDragIndex, index); vialDragIndex = null; vialDragoverIndex = null; }}
                ondragend={() => { vialDragIndex = null; vialDragoverIndex = null; }}
              >
                <td>
                  <div class="reorder-cell">
                    {#if settingsOpen}
                      <button
                        type="button"
                        class="drag-handle"
                        id="vial-row-handle-{row.vialId}"
                        aria-roledescription="Drag handle"
                        aria-label="Reorder vial {row.vialId}"
                        aria-pressed={vialKbIndex === index}
                        ondragstart={(e) => e.preventDefault()}
                        onkeydown={(e) => vialRowKeydown(e, index)}
                      >⠿</button>
                    {/if}
                    <span>{row.vialId}</span>
                    {#if settingsOpen}
                      {#if medRow?.archived || (medRow?.dosesLeft ?? 0) <= 0}
                        <button
                          type="button"
                          class="archive-btn"
                          class:active={medRow?.archived}
                          aria-label={medRow?.archived ? `Restore vial ${row.vialId}` : `Archive vial ${row.vialId}`}
                          aria-pressed={medRow?.archived ?? false}
                          title={medRow?.archived ? 'Restore vial' : 'Archive spent vial'}
                          onclick={() => setVialArchived(row.vialId, !medRow?.archived)}
                        >{medRow?.archived ? '⤒' : '⤓'}</button>
                      {/if}
                      <button
                        type="button"
                        class="delete-btn"
                        aria-label={`Delete vial ${row.vialId}`}
                        onclick={() => deleteMedicationRow(row.vialId)}
                      >×</button>
                    {/if}
                  </div>
                  {@render cardActions(row.vialId)}
                </td>
                {#each activeVialCols as col, colIndex (col.key)}
                  {@const vEditing = $isMobile ? isRowMobileEditing(row.vialId) : vialGrid.isCellEditing(displayIndex, colIndex)}
                  {@const vMed = getMedRowById(row.vialId)}
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <td
                    data-label={col.label}
                    data-vial-cell="{displayIndex}-{colIndex}"
                    class="med-cell"
                    class:col-pharmacy={col.key === 'pharmacy'}
                    class:col-narrow={col.key === 'compoundDate' || col.key === 'lotNumber' || col.key === 'costPerMg'}
                    class:cell-editing={vEditing && col.key !== 'costPerMg' && !$isMobile}
                    class:col-indicator-left={vialSettingsActive && vialColIndicator?.col === colIndex && vialColIndicator?.side === 'left'}
                    class:col-indicator-right={vialSettingsActive && vialColIndicator?.col === colIndex && vialColIndicator?.side === 'right'}
                    tabindex={$isMobile ? undefined : vialGrid.tabIndexFor(displayIndex, colIndex, displayIndex === 0 && colIndex === 0)}
                    onclick={$isMobile ? undefined : () => vialGrid.selectCell(displayIndex, colIndex, true)}
                    onkeydown={$isMobile ? undefined : (e) => vialGrid.cellKeydown(e, displayIndex, colIndex)}
                    onfocusin={$isMobile ? undefined : () => { if (vialGrid.selRow === null) { vialGrid.selRow = displayIndex; vialGrid.selCol = colIndex; } }}
                  >
                    {#if col.key === 'compoundDate'}
                      {#if vEditing}
                        <DateInput value={row.compoundDate} onchange={(v) => setVialField(row.vialId, 'compoundDate', v as IsoDate | '')} onkeydown={$isMobile ? undefined : vialGrid.editorKeydown} onblur={() => vialGrid.stopEditing()} />
                      {:else}{formatLocaleDate(row.compoundDate)}{/if}
                    {:else if col.key === 'bud'}
                      {#if vEditing}
                        <DateInput value={row.bud} onchange={(v) => setVialField(row.vialId, 'bud', v as IsoDate | '')} onkeydown={$isMobile ? undefined : vialGrid.editorKeydown} onblur={() => vialGrid.stopEditing()} />
                      {:else}{formatLocaleDate(row.bud)}{/if}
                    {:else if col.key === 'lotNumber'}
                      {#if vEditing}
                        <input class="med-input" type="text" bind:value={row.lotNumber} onkeydown={$isMobile ? undefined : vialGrid.editorKeydown} onblur={() => { vialGrid.stopEditing(); scheduleMedSave(); }} />
                      {:else}{row.lotNumber}{/if}
                    {:else if col.key === 'pharmacy'}
                      {#if vEditing && vMed}
                        <input class="med-input" type="text" value={vMed.pharmacy ?? ''} oninput={(e) => updateMedRowField(row.vialId, 'pharmacy', e.currentTarget.value)} onkeydown={$isMobile ? undefined : vialGrid.editorKeydown} onblur={() => vialGrid.stopEditing()} />
                      {:else}{vMed?.pharmacy ?? ''}{/if}
                    {:else if col.key === 'cost'}
                      {#if vEditing && vMed}
                        <input class="med-input" type="number" step="0.01" value={vMed.cost ?? 0} oninput={(e) => updateMedRowField(row.vialId, 'cost', parseFloat(e.currentTarget.value) || 0)} onkeydown={$isMobile ? undefined : vialGrid.editorKeydown} onblur={() => vialGrid.stopEditing()} />
                      {:else}{formatCurrency(vMed?.cost)}{/if}
                    {:else if col.key === 'costPerMg'}
                      {#if vMed}{formatCurrency(calculatedCostPerMg(vMed))}{/if}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
            {#if settingsOpen}
              <tr
                class="drop-sentinel"
                class:drop-sentinel-active={vialDragoverIndex === vialTrackingRows.length && vialDragIndex !== null}
                ondragover={(e) => { e.preventDefault(); vialDragoverIndex = vialTrackingRows.length; }}
                ondragleave={() => { if (vialDragoverIndex === vialTrackingRows.length) vialDragoverIndex = null; }}
                ondrop={() => { if (vialDragIndex !== null) { reorderVialRows(vialDragIndex, vialTrackingRows.length); vialDragIndex = null; vialDragoverIndex = null; } }}
              >
                <td colspan={activeVialCols.length + 1}></td>
              </tr>
            {/if}
          </tbody>
        </table>
        </div>
      {/if}
      </div>
    </article>

    <section class="med-summary-row">
      <article class="card">
        <h2 class="section-chip">Cost</h2>
        <table class="kv-table">
          <tbody>
            <tr>
              <th>Total Spend</th>
              <td>
                {#if totalSpend != null}
                  {formatCurrency(totalSpend)}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
            <tr>
              <th>{$weightUnit} Lost</th>
              <td>
                {#if displayLost != null}
                  {displayLost}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
            <tr>
              <th>$/{$weightUnit} Lost</th>
              <td>
                {#if costPerUnit != null}
                  {formatCurrency(costPerUnit)}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="card">
        <h2 class="section-chip">Reminders</h2>
        <div class="reminders-list">
          {#if !hasReminders}
            {#if hiddenReminderCount > 0}
              <p class="reminders-empty">
                No reminders remaining.
                {hiddenReminderCount} dismissed —
                <button type="button" class="reminders-restore" onclick={() => dismissedReminders.restoreAll()}>
                  restore
                </button>
                to review.
              </p>
            {:else}
              <p class="reminders-empty">Nothing pressing — supplies and vial dates look healthy.</p>
            {/if}
          {:else}
            {#each visibleBudReminders as reminder (reminder.dbId)}
              <p>
                <strong>Vial {reminder.vialNumber}</strong>
                ({shortDrugName(reminder.type)}) approaches its BUD on
                <strong>{formatShortDate(reminder.bud)}</strong>
                ({reminder.daysUntilBud} day{reminder.daysUntilBud === 1 ? '' : 's'}) — use it next.
                <button
                  type="button"
                  class="reminder-dismiss"
                  aria-label="Dismiss reminder"
                  title="Dismiss"
                  onclick={() => dismissedReminders.dismissBud(reminder.dbId, reminder.bud)}
                >×</button>
              </p>
            {/each}
            {#each visibleRefillReminders as reminder (reminder.type)}
              <p>
                Less than 1 month of <strong>{shortDrugName(reminder.type)}</strong>
                left ({formatDoses(reminder.dosesLeft)} dose{reminder.dosesLeft === 1 ? '' : 's'})
                — schedule a refill.
                <button
                  type="button"
                  class="reminder-dismiss"
                  aria-label="Dismiss reminder"
                  title="Dismiss"
                  onclick={() => dismissedReminders.dismissRefill(reminder.type, reminder.dosesLeft)}
                >×</button>
              </p>
            {/each}
          {/if}
        </div>
      </article>
    </section>
  </section>
</main>

{#if vialDeleteRequest !== null}
  <ConfirmDialog
    title="Delete this vial?"
    message="This permanently removes this vial and its tracking info. This cannot be undone. (To hide a spent vial instead, use Archive.)"
    confirmLabel="Delete"
    onConfirm={confirmVialDelete}
    onCancel={() => (vialDeleteRequest = null)}
  />
{/if}

<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">{announcement}</div>

<style>
  .content {
    width: min(100% - 2rem, 1240px);
    margin-inline: auto;
    padding: 1rem 0 1.25rem;
    display: grid;
    gap: 1rem;
  }

  .card {
    border: 1px solid var(--cardBorder);
    border-radius: 14px;
    background: color-mix(in oklab, var(--surface) 86%, transparent);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.16);
    padding: 0.75rem;
  }

  .chip-row {
    display: flex;
    align-items: stretch;
    gap: 0.4rem;
    /* Each tab extends a "skirt" (var(--tab-skirt)) below the line via extra
     * padding-bottom, cancelled by a negative margin so the flex layout height
     * is unaffected. The content panel sits on top (z-index) and hides the
     * skirt; the skirt is taller than the cards' corner radius, so a tab's
     * background/border runs down behind the rounded corner and blends in. */
    --tab-skirt: 1rem;
    margin-bottom: 0;
  }

  .section-chip {
    border: 1px solid var(--cardBorder);
    border-bottom-width: 0;
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
    background: color-mix(in oklab, var(--headerBg) 92%, transparent);
    color: var(--headerText);
    font-size: 1.1rem;
    font-weight: 700;
    font-variant: small-caps;
    line-height: 1;
    padding: 0.45rem 0.85rem 0.5rem;
    margin: 0;
  }

  .delete-btn {
    border: 0;
    border-radius: 8px;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    margin-left: 0.25rem;
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

  .archive-btn {
    border: 0;
    border-radius: 8px;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    margin-left: 0.25rem;
    background: color-mix(in oklab, var(--cardBorder) 14%, transparent 86%);
    color: color-mix(in oklab, var(--cardBorder) 70%, #555 30%);
    font-size: 1rem;
    font-weight: 700;
    line-height: 0;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
  }

  .archive-btn:hover {
    background: color-mix(in oklab, var(--cardBorder) 26%, transparent 74%);
  }

  /* Restore (already-archived) state reads as a filled, "on" chip. */
  .archive-btn.active {
    background: color-mix(in oklab, var(--headerBg) 86%, transparent);
    color: var(--headerText);
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

  .column-manager {
    border: 1px solid color-mix(in oklab, var(--cardBorder) 36%, white 64%);
    border-radius: 12px;
    padding: 0.55rem;
    margin-bottom: 0.65rem;
    display: grid;
    gap: 0.45rem;
    justify-items: start;
    /* Solid fill: this panel sits above the chip strip (via .tab-panel's
     * z-index), so a transparent background would let the tab skirts show
     * through it. Opaque --surface paints them out cleanly. */
    background: var(--surface);
  }

  .column-manager fieldset {
    width: 100%;
  }

  fieldset {
    border: 1px solid color-mix(in oklab, var(--cardBorder) 30%, white 70%);
    border-radius: 10px;
    padding: 0.5rem;
    min-width: 0;
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
  }

  .option-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, white 60%);
    border-radius: 999px;
    padding: 0.15rem 0.45rem;
    background: color-mix(in oklab, var(--surface) 78%, transparent);
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: 0.9rem;
  }

  .option-chip:hover {
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

  .restore-mark {
    color: var(--cardBorder);
    font-size: 1rem;
    font-weight: 800;
    line-height: 1;
  }

  .archived-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.92rem;
    cursor: pointer;
  }

  .archived-toggle input {
    cursor: pointer;
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

  /* Action buttons share the inactive-tab look: a chip on the table's line. */
  .add-row-btn {
    border: 1px solid transparent;
    border-radius: 12px 12px 0 0;
    width: 2.5rem;
    /* Same skirt as the tabs so a rightmost button's bottom corner tucks behind
     * the content instead of hanging off the card's rounded corner. */
    padding: 0 0 var(--tab-skirt);
    margin-bottom: calc(-1 * var(--tab-skirt));
    background: color-mix(in oklab, var(--headerBg) 92%, transparent);
    color: var(--headerText);
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 0;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }

  .add-row-btn:hover,
  .mini-icon:hover {
    background: color-mix(in oklab, var(--headerBg) 82%, white 18%);
  }


  .mini-icon {
    border: 1px solid transparent;
    border-radius: 12px 12px 0 0;
    width: 2.5rem;
    padding: 0 0 var(--tab-skirt);
    margin-bottom: calc(-1 * var(--tab-skirt));
    background: color-mix(in oklab, var(--headerBg) 92%, transparent);
    line-height: 0;
    cursor: pointer;
    color: var(--headerText);
    display: inline-grid;
    place-items: center;
    --edit-icon-scale: 1.15rem;
  }

  .mini-icon.active {
    background: color-mix(in oklab, var(--headerBg) 96%, #f2ca67 4%);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 1.15rem;
  }

  th,
  td {
    padding: 0.4rem 0.45rem;
    border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 42%, #f2f2f2 58%);
  }

  .inputs-table thead tr {
    background: color-mix(in oklab, var(--headerBg) 60%, white 40%);
    color: var(--headerText);
  }

  .inputs-table tbody tr:nth-child(even) {
    background: var(--rowAlt);
  }

  .inputs-table th,
  .inputs-table td {
    border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, #f0f0f0 60%);
  }

  .inputs-table th,
  .inputs-table td {
    text-align: center;
  }

  .inputs-table .col-type,
  .inputs-table .col-pharmacy {
    text-align: left;
  }

  .inputs-table th.col-narrow {
    width: 1px;
    white-space: nowrap;
  }

  .inputs-table th.col-bud,
  .inputs-table th.col-cost {
    min-width: 7ch;
    white-space: nowrap;
  }

  .inputs-table td.col-compact input {
    width: 4.5rem;
  }

  .inputs-table td {
    vertical-align: top;
  }

  .table-scroll {
    overflow-x: auto;
    max-width: 100%;
    min-width: 0;
  }

  .kv-table th {
    text-align: left;
    width: 62%;
  }

  .kv-table td {
    text-align: right;
    font-weight: 700;
  }

  .medication-layout {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  /* Grid/flex children default to min-width:auto (min-content), which lets the
   * wide tables inside push the whole layout past the viewport. min-width:0
   * lets the fr tracks actually shrink so the .table-scroll wrappers scroll
   * internally instead of overflowing the page. */
  .medication-layout > *,
  .med-summary-row > * {
    min-width: 0;
  }

  .med-table-card {
    overflow-x: auto;
    min-width: 0;
  }

  /* Opaque panel that paints over the chips' skirts so they vanish cleanly
   * behind the content (on desktop the table fills this, so it never shows). */
  .tab-panel {
    /* Sits above the chip strip so the table/cards always cover the tab skirts
     * (and any overlap of tab and content shows the content on top). */
    position: relative;
    z-index: 1;
  }

  .medication-table {
    min-width: 950px;
  }

  /* Two-state spreadsheet cells (shared model with the inputs table): a faint
     always-on affordance signals editability; the selection ring follows real
     :focus (so only one selector shows on the page); a stronger inner shadow
     while editing. The type cell renders a picker that owns its own indicator,
     so it's excluded from the edit ring. */
  .medication-table td.med-cell {
    position: relative;
    cursor: pointer;
    outline: none;
  }
  .medication-table td.med-cell:focus {
    box-shadow: inset 0 0 0 2px var(--accent);
    border-radius: 4px;
  }
  .medication-table td.med-cell.cell-editing:not(.col-type) {
    box-shadow:
      inset 0 0 0 2.5px color-mix(in oklab, var(--accent) 30%, var(--text) 70%),
      inset 0 0 18px 4px color-mix(in oklab, var(--accent) 60%, transparent);
    border-radius: 4px;
  }
  /* Overlay the cell instead of sitting in flow, so the editor's intrinsic width
     can't widen the column — the cell keeps its static-text width and the editor
     fills it (identical footprint, only the selector differs). .med-cell is
     already position:relative. Reverted to in-flow on mobile (≤640px block). */
  .medication-table .med-input {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    width: 100%;
    border: 0;
    border-radius: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    text-align: inherit;
    outline: none;
    padding: 0.2rem 0.3rem;
  }

  /* Cost + Reminders sit side by side when there's room, and wrap to a single
   * column when there isn't — no hard breakpoint, stays fluid at any width. */
  .med-summary-row {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  }

  /* ── Tabbed table header ── */
  .med-tabs {
    display: flex;
    gap: 0.3rem;
    min-width: 0;
  }

  .med-tab {
    /* Transparent border: the table (painted in front) draws the one border
     * line; the selected tab adds its own top/side outline above it. */
    border: 1px solid transparent;
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
    background: color-mix(in oklab, var(--headerBg) 92%, transparent);
    color: var(--headerText);
    font-size: 1.1rem;
    font-weight: 700;
    font-variant: small-caps;
    line-height: 1;
    padding: 0.45rem 0.75rem calc(0.5rem + var(--tab-skirt));
    margin-bottom: calc(-1 * var(--tab-skirt));
    white-space: nowrap;
    cursor: pointer;
  }

  .med-tab:not(.active):hover {
    background: color-mix(in oklab, var(--headerBg) 82%, white 18%);
  }

  .med-tab.active {
    /* Outline matches the content's border colour. No bottom border — the side
     * borders butt straight down (no 45° miter) and the content covers them. */
    border-color: color-mix(in oklab, var(--cardBorder) 40%, #f0f0f0 60%);
    border-bottom: 0;
  }

  .reminders-list p {
    position: relative;
    margin: 0 0 0.55rem;
    padding-right: 1.4rem;
    font-size: 1.02rem;
  }

  .reminders-list p:last-child {
    margin-bottom: 0;
  }

  .reminder-dismiss {
    position: absolute;
    top: 0;
    right: 0;
    background: none;
    border: none;
    padding: 0 0.25rem;
    font: inherit;
    font-size: 1.05rem;
    line-height: 1;
    color: color-mix(in oklab, var(--cardBorder) 55%, #888 45%);
    opacity: 0.5;
    cursor: pointer;
    transition: opacity 0.15s ease, color 0.15s ease;
  }

  .reminder-dismiss:hover,
  .reminder-dismiss:focus-visible {
    opacity: 1;
    color: inherit;
  }

  .reminders-restore {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
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

  tr[draggable='true'] {
    cursor: grab;
  }

  tr.row-dragging {
    opacity: 0.4;
  }

  tr.row-dragover td {
    border-top: 3px solid var(--cardBorder) !important;
  }

  tr.drop-sentinel td {
    height: 1.5rem;
    border: none !important;
  }

  tr.drop-sentinel.drop-sentinel-active td {
    border-top: 3px solid var(--cardBorder) !important;
  }

  th[draggable='true'] {
    cursor: grab;
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

  .reorder-cell {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .inputs-table tbody tr.vial-status-warning {
    background: var(--vialWarning);
  }

  .inputs-table tbody tr.vial-status-active {
    background: var(--vialActive);
  }

  .inputs-table tbody tr.vial-status-neutral {
    background: transparent;
  }

  /* Header toggle that flips the remaining column between doses and mg. Reads as
   * a column label, not a chunky button. */
  .vial-unit-toggle {
    font: inherit;
    font-weight: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: underline dotted;
    text-underline-offset: 0.18rem;
  }
  .vial-unit-toggle:hover,
  .vial-unit-toggle:focus-visible {
    text-decoration-style: solid;
  }

  /* Overfill marker: this vial has been drawn past its labeled fill. */
  .vial-over {
    margin-left: 0.3rem;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: color-mix(in oklab, var(--warning, #e08a3c) 80%, var(--text, #000) 20%);
  }

  /* Archived vials only appear when "Show archived vials" is on; mute them so
   * they read as set-aside without hiding their data. */
  .inputs-table tbody tr.row-archived {
    opacity: 0.55;
  }

  .inputs-table :global(input) {
    width: 100%;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 35%, #d4d4d4 65%);
    border-radius: 8px;
    font-size: 0.98rem;
    padding: 0.2rem 0.34rem;
    background: color-mix(in oklab, var(--surface) 92%, transparent);
    color: var(--text);
  }

  .empty-value {
    color: color-mix(in oklab, currentColor 45%, transparent);
  }

  @media (max-width: 1100px) {
    .medication-table {
      min-width: 760px;
    }
  }

  /* Per-card controls live in the card header ("Vial N") row on mobile only; the
     desktop spreadsheet never shows them. */
  .card-header-actions {
    display: none;
  }

  /* ── Phone layout (≤640px): both tabs render one card per vial. ───────────
   * Responsive-table pattern — the <table>/edit/drag logic is untouched; the
   * thead is visually hidden and each <td>'s data-label becomes its row label. */
  @media (max-width: 640px) {
    /* Reclaim horizontal room on very narrow phones (e.g. iPhone SE) so the tab
     * strip's buttons don't collide with the Vial Info tab. */
    .content {
      min-width: calc(100% - 1rem);
    }

    /* Drop the min-width scroll and let rows stack as cards. */
    .med-table-card {
      overflow-x: visible;
      padding: 0.5rem;
    }

    .med-table-card .table-scroll {
      overflow-x: visible;
      max-width: none;
    }

    .med-table-card .medication-table {
      min-width: 0;
    }

    .med-table-card .medication-table,
    .med-table-card .medication-table tbody {
      display: block;
    }

    /* Keep the header in the DOM for screen readers, but hide it visually. */
    .med-table-card .medication-table thead {
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

    .med-table-card .medication-table tbody tr {
      display: block;
      border: 1px solid color-mix(in oklab, var(--cardBorder) 40%, #f0f0f0 60%);
      border-radius: 12px;
      padding: 0.35rem 0.6rem 0.5rem;
      margin-bottom: 0.6rem;
    }

    /* Cards must be opaque so the tab skirt shows only at their rounded corners,
     * not through the body. The vial-status / row tints are semi-transparent, so
     * paint them as an overlay on an opaque --surface base — same composited
     * colour as elsewhere, but no longer see-through. (Order mirrors the desktop
     * cascade: status tints win over the even-row tint.) */
    .med-table-card .medication-table tbody tr {
      background: var(--surface);
    }

    /* No zebra striping in the card layout — every card is the same surface
       (status tints below still apply). */
    .med-table-card .medication-table tbody tr:nth-child(even) {
      background: var(--surface);
    }

    .med-table-card .medication-table tbody tr.vial-status-active {
      background: linear-gradient(var(--vialActive), var(--vialActive)), var(--surface);
    }

    .med-table-card .medication-table tbody tr.vial-status-warning {
      background: linear-gradient(var(--vialWarning), var(--vialWarning)), var(--surface);
    }

    .med-table-card .medication-table tbody tr.vial-status-neutral {
      background: var(--surface);
    }

    .med-table-card .medication-table tbody tr:last-child {
      margin-bottom: 0;
    }

    .med-table-card .medication-table td {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      text-align: right;
      border: none;
      border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 22%, transparent);
      padding: 0.34rem 0;
    }

    .med-table-card .medication-table td:last-child {
      border-bottom: none;
    }

    .med-table-card .medication-table td::before {
      content: attr(data-label);
      flex: 0 1 auto;
      text-align: left;
      font-weight: 600;
      font-variant: small-caps;
      color: color-mix(in oklab, currentColor 60%, transparent);
    }

    /* The Vial cell is the card header row: "Vial N" on the left, per-card
       controls (pencil, or Save/Cancel/Delete/Archive) on the right. */
    .med-table-card .medication-table td:first-child {
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      column-gap: 0.5rem;
      border-bottom: 1px solid color-mix(in oklab, var(--cardBorder) 32%, transparent);
      padding-top: 0.1rem;
      margin-bottom: 0.15rem;
      font-weight: 700;
      font-size: 1.05rem;
    }

    .med-table-card .medication-table td:first-child::before {
      content: none;
    }

    .med-table-card .reorder-cell span::before {
      content: 'Vial ';
    }

    /* Inputs/selects share the row with their label instead of filling it. */
    /* The desktop overlay (position:absolute) doesn't apply to the card layout —
       here the editor is an in-flow flex item beside its label. */
    .med-table-card .medication-table :global(.med-input) {
      position: static;
    }

    .med-table-card .medication-table td :global(input),
    .med-table-card .medication-table td :global(select) {
      width: auto;
      flex: 1 1 0;
      min-width: 0;
      max-width: 62%;
    }

    .med-table-card .medication-table td.col-compact :global(input) {
      width: auto;
    }

    /* Drag-to-reorder is a pointer affordance; the empty drop row is noise here. */
    .med-table-card .medication-table tr.drop-sentinel {
      display: none;
    }

    /* ── Per-card controls in the header row ──
     * The desktop keyboard grid is disabled at this width; each card carries its
     * own pencil (Save / Cancel / Delete / Archive once open). The gear's
     * Hidden-columns manager and its per-row gutter drag/delete/archive are
     * redundant on mobile (delete/archive live in the card), so hide them. */
    .card-header-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.4rem;
      font-weight: 400;
    }

    /* Icon buttons (Save/Archive/Delete) are compact squares; Cancel keeps text. */
    .card-action-btn {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      padding: 0.35rem 0.55rem;
      font-weight: 700;
      font-size: 0.9rem;
      line-height: 0;
      cursor: pointer;
      border: 1.5px solid color-mix(in oklab, var(--cardBorder) 35%, #d4d4d4 65%);
      background: color-mix(in oklab, var(--surface) 82%, transparent);
      color: var(--text);
    }

    .card-action-btn.card-save {
      border-color: transparent;
      background: var(--accent, var(--text));
      color: var(--surface);
    }

    .card-action-btn.card-delete {
      border-color: transparent;
      background: var(--danger);
      color: white;
    }

    .hidden-columns-fieldset {
      display: none;
    }

    /* Keep the "Vial N" header but drop the gear gutter's drag/delete/archive. */
    .med-table-card .reorder-cell .drag-handle,
    .med-table-card .reorder-cell .delete-btn,
    .med-table-card .reorder-cell .archive-btn {
      display: none;
    }
  }
</style>

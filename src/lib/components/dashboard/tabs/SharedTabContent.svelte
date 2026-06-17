<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import EditPencil from '$lib/components/dashboard/EditPencil.svelte';
  import GearIcon from '$lib/components/icons/GearIcon.svelte';
  import WarnBadge from '$lib/components/icons/WarnBadge.svelte';
  import HelpBadge from '$lib/components/icons/HelpBadge.svelte';
  import InputsTable from '$lib/components/dashboard/tables/InputsTable.svelte';
  import { GridSelection } from '$lib/grid/gridSelection.svelte';
  import {
    startWeight,
    currentWeight,
    goalWeight,
    setStartAndGoalWeight,
  } from '$lib/stores/progressStore';
  import { rawPrescriptions } from '$lib/stores/medicationStore';
  import { healthEntries } from '$lib/stores/healthStore';
  import { symptomColors } from '$lib/stores/symptomStore';
  import { weightUnit, toStoredLbs, type WeightUnit } from '$lib/stores/unitStore';
  import {
    buildChartModel,
    CHART,
    GRAPH_SERIES,
    PLOT,
    type ChartXRange,
    type GraphSeriesKey,
  } from '$lib/utils/chartModel';
  import { localDateKey } from '$lib/utils/dateKeys';
  import { lbsToDisplayNum } from '$lib/utils/format';
  import type { DrugShape } from '$lib/utils/pharmacokinetics';

  // Per-drug SVG markers (universal design: every series has both a color and a
  // distinct shape, so they stay distinguishable in greyscale, when overlapping,
  // for color-vision differences, and in print).
  function shapePath(shape: DrugShape): string {
    switch (shape) {
      case 'circle':   return 'M -3.2 0 A 3.2 3.2 0 1 0 3.2 0 A 3.2 3.2 0 1 0 -3.2 0';
      case 'square':   return 'M -2.9 -2.9 H 2.9 V 2.9 H -2.9 Z';
      case 'triangle': return 'M 0 -3.8 L 3.4 2.1 L -3.4 2.1 Z';
      case 'diamond':  return 'M 0 -3.6 L 3.6 0 L 0 3.6 L -3.6 0 Z';
      case 'plus':     return 'M -1.1 -3.2 H 1.1 V -1.1 H 3.2 V 1.1 H 1.1 V 3.2 H -1.1 V 1.1 H -3.2 V -1.1 H -1.1 Z';
      case 'star':     return 'M 0 -3.6 L 1.05 -1.05 L 3.6 0 L 1.05 1.05 L 0 3.6 L -1.05 1.05 L -3.6 0 L -1.05 -1.05 Z';
      case 'hexagon':  return 'M 0 -3.4 L 2.95 -1.7 L 2.95 1.7 L 0 3.4 L -2.95 1.7 L -2.95 -1.7 Z';
    }
  }

  const hiddenGraphSeries = new SvelteSet<GraphSeriesKey>();

  // Desktop offers a range selector; mobile is locked to one week (the selector
  // is hidden and the range forced regardless of the saved choice) so the narrow
  // viewport never tries to cram a quarter of a year onto the screen.
  type XRangePreset = '1w' | '4w' | '12w' | 'all';
  const X_RANGE_PRESETS: { key: XRangePreset; label: string; range: ChartXRange }[] = [
    { key: '1w', label: '1W', range: { visibleDays: 7 } },
    { key: '4w', label: '4W', range: { visibleDays: 28 } },
    { key: '12w', label: '12W', range: { visibleDays: 84 } },
    { key: 'all', label: 'All', range: 'all' },
  ];
  const ONE_WEEK_RANGE: ChartXRange = { visibleDays: 7 };
  let xRangeChoice = $state<XRangePreset>('1w');

  // Mirror the ≤640px card breakpoint used elsewhere; drives both hiding the
  // selector and forcing the one-week range on mobile.
  let isNarrowView = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    isNarrowView = mq.matches;
    const onChange = () => (isNarrowView = mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });

  const xRange = $derived(
    isNarrowView
      ? ONE_WEEK_RANGE
      : X_RANGE_PRESETS.find((p) => p.key === xRangeChoice)?.range ?? 'all',
  );

  async function selectXRange(next: XRangePreset) {
    if (next === xRangeChoice) return;
    const el = dataScrollEl;
    let anchorDate = null;
    if (el && chartModel.hasAnyData) {
      anchorDate = chartModel.dateForCssX(el.scrollLeft + el.clientWidth);
    }
    xRangeChoice = next;
    await tick();
    if (!el || !anchorDate) return;
    const targetX = chartModel.cssXForDate(anchorDate);
    if (Number.isFinite(targetX)) {
      el.scrollLeft = Math.max(0, targetX - el.clientWidth);
    }
  }

  // Viewport width of the scrollable plot area in CSS pixels. Tracked so the
  // chart can compute pixels-per-day from the selected x-range preset.
  let viewportPlotWidth = $state(0);

  function attachViewportObserver(el: HTMLDivElement) {
    dataScrollEl = el;
    viewportPlotWidth = el.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(w - viewportPlotWidth) > 0.5) viewportPlotWidth = w;
    });
    observer.observe(el);
    return {
      destroy() {
        observer.disconnect();
        if (dataScrollEl === el) dataScrollEl = null;
      },
    };
  }

  let {
    active = true,
    discardSignal = 0,
    onUnsavedChange,
  }: {
    active?: boolean;
    discardSignal?: number;
    onUnsavedChange?: (hasUnsavedChanges: boolean) => void;
  } = $props();

  let isEditingLegend = $state(false);
  // The inputs table is a single always-editable spreadsheet now (auto-save);
  // the gear toggles its settings (column manager + option managers + the
  // per-row trash gutter), independent of any edit mode.
  let inputSettingsOpen = $state(false);
  let addInputRowSignal = $state(0);
  let draftStartWeight = $state<number | ''>(lbsToDraftInput($startWeight, $weightUnit));
  let draftGoalWeight = $state<number | ''>(lbsToDraftInput($goalWeight, $weightUnit));
  let progressBaseStartWeightLbs = $state<number | null>($startWeight);
  let progressBaseGoalWeightLbs = $state<number | null>($goalWeight);
  let progressDraftUnit = $state<WeightUnit>($weightUnit);
  let progressCardRegion: HTMLElement | null = null;
  let legendRegion: HTMLElement | null = null;

  // Progress card editable cells modelled as a one-column grid: Start Weight is
  // row 0, Goal Weight row 2 of the key/value table; the computed rows between
  // and after aren't navigable. Always-editable two-state cells with auto-save,
  // sharing the spreadsheet engine with the inputs/medication tables.
  const PROGRESS_START_ROW = 0;
  const PROGRESS_GOAL_ROW = 2;
  const progressFieldEditable = (r: number) => r === PROGRESS_START_ROW || r === PROGRESS_GOAL_ROW;
  function commitProgressFields() {
    const startLbs = progressDraftValueToLbs(draftStartWeight, $weightUnit);
    const goalLbs = progressDraftValueToLbs(draftGoalWeight, $weightUnit);
    setStartAndGoalWeight(startLbs, goalLbs);
    progressBaseStartWeightLbs = startLbs;
    progressBaseGoalWeightLbs = goalLbs;
  }
  const progressGrid = new GridSelection({
    rowCount: () => 3,
    colCount: () => 1,
    isEditable: (r) => progressFieldEditable(r),
    isSelectable: (r) => progressFieldEditable(r),
    cellRef: (r, c) =>
      progressCardRegion?.querySelector<HTMLElement>(`[data-cell="${r}-${c}"]`) ?? null,
    commit: () => commitProgressFields(),
    clear: (r) => {
      if (r === PROGRESS_START_ROW) draftStartWeight = '';
      else if (r === PROGRESS_GOAL_ROW) draftGoalWeight = '';
      commitProgressFields();
    },
    beginEditSeed: (r, _c, seed) => {
      const typed = seed !== null && Number.isFinite(Number(seed)) ? Number(seed) : '';
      if (r === PROGRESS_START_ROW) {
        draftStartWeight = seed !== null ? typed : lbsToDraftInput($startWeight, $weightUnit);
      } else if (r === PROGRESS_GOAL_ROW) {
        draftGoalWeight = seed !== null ? typed : lbsToDraftInput($goalWeight, $weightUnit);
      }
    },
    cancelEdit: (r) => {
      if (r === PROGRESS_START_ROW) draftStartWeight = lbsToDraftInput($startWeight, $weightUnit);
      else if (r === PROGRESS_GOAL_ROW) draftGoalWeight = lbsToDraftInput($goalWeight, $weightUnit);
    },
    stickyTopSelector: '.tabbar',
  });
  let dataScrollEl: HTMLDivElement | null = null;
  let hasAutoScrolled = false;
  let lastNotifiedUnsavedChanges = false;
  let lastDiscardSignal = getInitialDiscardSignal();

  $effect(() => {
    if (!active || !dataScrollEl || hasAutoScrolled || !chartModel.hasAnyData) return;
    hasAutoScrolled = true;
    requestAnimationFrame(() => {
      if (dataScrollEl) dataScrollEl.scrollLeft = dataScrollEl.scrollWidth;
    });
  });

  /**
   * Switch the visible-window preset while keeping the right-most visible date
   * pinned at the right edge. We capture the anchor date from the OLD model's
   * geometry, swap the preset, then use the NEW model's geometry to position
   * scrollLeft so the same date lands at the right edge again.
   */
  $effect(() => {
    if (active) return;
    isEditingLegend = false;
    progressGrid.editing = false;
    inputSettingsOpen = false;
  });

  $effect(() => {
    if (hasUnsavedChanges === lastNotifiedUnsavedChanges) return;
    lastNotifiedUnsavedChanges = hasUnsavedChanges;
    onUnsavedChange?.(hasUnsavedChanges);
  });

  $effect(() => {
    if (discardSignal === lastDiscardSignal) return;
    lastDiscardSignal = discardSignal;
    if (hasUnsavedProgress) discardProgressEdits();
  });

  const sortedHealthRows = $derived([...$healthEntries].sort((a, b) => a.date.localeCompare(b.date)));
  const todayKey = $derived(localDateKey());
  const chartModel = $derived.by(() =>
    buildChartModel(
      sortedHealthRows,
      $weightUnit,
      $symptomColors,
      $currentWeight != null ? lbsToDisplayNum(String($currentWeight), $weightUnit) : 180,
      todayKey,
      hiddenGraphSeries,
      xRange,
      viewportPlotWidth > 0 ? viewportPlotWidth : undefined,
    ),
  );
  type LegendItem = {
    key: GraphSeriesKey;
    label: string;
    className: string;
    hidden: boolean;
    color?: string;
    shape?: DrugShape;
  };

  const legendItems = $derived.by<LegendItem[]>(() =>
    GRAPH_SERIES.flatMap((item) => {
      if (item.key !== 'systemMg') {
        return [{ ...item, hidden: hiddenGraphSeries.has(item.key) }];
      }

      return chartModel.systemSeries.map((series) => ({
        key: series.key,
        label: series.label,
        className: item.className,
        hidden: hiddenGraphSeries.has(series.key),
        color: series.color,
        shape: series.shape,
      }));
    }),
  );
  const showLeftAxis = $derived(!hiddenGraphSeries.has('weight'));
  const hasVisibleSystemSeries = $derived(
    chartModel.systemSeries.some((series) => !hiddenGraphSeries.has(series.key)),
  );
  const showRightAxis = $derived(
    hasVisibleSystemSeries || !hiddenGraphSeries.has('wellness'),
  );
  const showAnyAxis = $derived(showLeftAxis || showRightAxis);
  const effectiveLeftTicks = $derived(showLeftAxis ? chartModel.leftTicks : chartModel.rightTicks);
  const effectiveRightTicks = $derived(showRightAxis ? chartModel.rightTicks : chartModel.leftTicks);
  const effectiveLeftLabel = $derived(showLeftAxis ? chartModel.leftAxisLabel : chartModel.rightAxisLabel);
  const effectiveRightLabel = $derived(showRightAxis ? chartModel.rightAxisLabel : chartModel.leftAxisLabel);

  // ---- Crosshair tracking ------------------------------------------------
  // hoverY is in viewBox / CSS-pixel space (the data-svg's CSS height equals
  // its viewBox height, so the two are 1:1). hoverDate is snapped to the
  // nearest day column under the cursor.
  let hoverY = $state<number | null>(null);
  let hoverDate = $state<import('$lib/domain/types').IsoDate | null>(null);
  let hoverDose = $state<{
    label: string;
    color: string;
    x: number;
    y: number;
  } | null>(null);

  const crosshairActive = $derived(hoverY !== null && hoverDate !== null);
  // Format crosshair values for the axis chips. Left axis is weight (1 decimal
  // looks right for both lb and kg); right axis is mg in system or wellness,
  // both of which are best read as integers.
  const hoverValueLeft = $derived(
    hoverY != null && showLeftAxis ? chartModel.valueLeftForY(hoverY) : null,
  );
  const hoverValueRight = $derived(
    hoverY != null && showRightAxis ? chartModel.valueRightForY(hoverY) : null,
  );
  const showMedicationInTooltip = $derived(chartModel.systemSeries.length > 1);

  function setCrosshairFromClient(clientX: number, clientY: number) {
    if (!dataScrollEl || !chartModel.hasAnyData) return;
    const rect = dataScrollEl.getBoundingClientRect();
    const cssX = clientX - rect.left + dataScrollEl.scrollLeft;
    const cssY = clientY - rect.top;
    if (cssY < PLOT.top || cssY > PLOT.bottom) {
      hoverY = null;
      hoverDate = null;
      return;
    }
    hoverY = cssY;
    hoverDate = chartModel.dateForCssX(cssX);
  }

  function onPlotMouseMove(event: MouseEvent) {
    setCrosshairFromClient(event.clientX, event.clientY);
  }

  function clearCrosshair() {
    hoverY = null;
    hoverDate = null;
    hoverDose = null;
  }

  // ── Touch ────────────────────────────────────────────────────────────────
  // The plot area scrolls horizontally, so a touch *drag* must stay a scroll. We
  // treat a touch that barely moves as a *tap* and read the value at that point
  // (mouse keeps its hover crosshair). On touch there's no mouseleave, so dose
  // tooltips are opened by tap and dismissed by tapping elsewhere (or off-chart),
  // instead of sticking forever.
  let touchTapStart: { x: number; y: number; t: number } | null = null;
  function onPlotPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse') return;
    touchTapStart = { x: event.clientX, y: event.clientY, t: performance.now() };
  }
  function onPlotPointerUp(event: PointerEvent) {
    if (event.pointerType === 'mouse' || !touchTapStart) return;
    const moved = Math.hypot(event.clientX - touchTapStart.x, event.clientY - touchTapStart.y);
    const heldMs = performance.now() - touchTapStart.t;
    touchTapStart = null;
    if (moved > 10 || heldMs > 500) return; // it was a scroll/drag, not a tap
    hoverDose = null; // tapping the plot background dismisses a dot tooltip
    setCrosshairFromClient(event.clientX, event.clientY);
  }
  function showDoseTooltipOnTouch(event: PointerEvent, marker: { label: string; color: string; x: number; y: number }) {
    if (event.pointerType === 'mouse') return; // mouse uses hover (enter/leave)
    event.stopPropagation(); // don't let the plot's tap handler clear it
    hoverDose = marker;
  }

  // Dismiss a touch-opened crosshair / dose tooltip when tapping outside the plot.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onDocPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      if (dataScrollEl && event.target instanceof Node && dataScrollEl.contains(event.target)) return;
      hoverDose = null;
      hoverY = null;
      hoverDate = null;
    };
    window.addEventListener('pointerdown', onDocPointerDown);
    return () => window.removeEventListener('pointerdown', onDocPointerDown);
  });

  function formatHoverWeight(v: number): string {
    return `${v.toFixed(1)} ${$weightUnit}`;
  }
  function formatHoverRight(v: number): string {
    return chartModel.systemSeries.length > 0
      ? `${v.toFixed(1)} mg`
      : v.toFixed(1);
  }

  const leftChipLabel = $derived(hoverValueLeft != null ? formatHoverWeight(hoverValueLeft) : '');
  const rightChipLabel = $derived(hoverValueRight != null ? formatHoverRight(hoverValueRight) : '');

  // Hug the chip background to the rendered label. getComputedTextLength returns
  // SVG user units, which equal CSS px at the axis SVG's 1:1 viewBox scale, so it
  // drops straight into the rect width. We re-measure whenever the label changes;
  // before the first measurement (or a char-width fallback) keeps it close.
  const CHIP_PAD_X = 5;
  let leftChipTextEl = $state<SVGTextElement | null>(null);
  let rightChipTextEl = $state<SVGTextElement | null>(null);
  let leftChipTextW = $state(0);
  let rightChipTextW = $state(0);
  $effect(() => {
    leftChipLabel;
    leftChipTextW = leftChipTextEl ? leftChipTextEl.getComputedTextLength() : 0;
  });
  $effect(() => {
    rightChipLabel;
    rightChipTextW = rightChipTextEl ? rightChipTextEl.getComputedTextLength() : 0;
  });
  const leftChipW = $derived((leftChipTextW || leftChipLabel.length * 6.6) + CHIP_PAD_X * 2);
  const rightChipW = $derived((rightChipTextW || rightChipLabel.length * 6.6) + CHIP_PAD_X * 2);

  function doseTooltipText(marker: { amountMg: number; medication: string }): string {
    const mg = `${marker.amountMg} mg`;
    return showMedicationInTooltip && marker.medication
      ? `${mg} · ${marker.medication}`
      : mg;
  }
  const currentWeightDisplay = $derived(
    $currentWeight != null ? lbsToDisplayNum(String($currentWeight), $weightUnit) : null,
  );
  const startWeightDisplay = $derived(
    $startWeight != null ? lbsToDisplayNum(String($startWeight), $weightUnit) : null,
  );
  const goalWeightDisplay = $derived(
    $goalWeight != null ? lbsToDisplayNum(String($goalWeight), $weightUnit) : null,
  );
  const weightToGoal = $derived(
    currentWeightDisplay != null && goalWeightDisplay != null
      ? Math.max(currentWeightDisplay - goalWeightDisplay, 0)
      : null,
  );
  const percentLoss = $derived.by(() => {
    const start = $startWeight;
    const current = $currentWeight;
    if (start == null || current == null || start <= 0) return null;
    return ((start - current) / start) * 100;
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
  const costPerLb = $derived(
    totalSpend != null && lbsLost != null && lbsLost > 0
      ? totalSpend / lbsLost
      : null,
  );
  const costPerUnit = $derived(
    costPerLb != null
      ? ($weightUnit === 'kg' ? costPerLb * 2.20462 : costPerLb)
      : null,
  );
  const unitLabel = $derived($weightUnit === 'lbs' ? 'lb' : 'kg');
  const draftStartWeightLbs = $derived(progressDraftValueToLbs(draftStartWeight, progressDraftUnit));
  const draftGoalWeightLbs = $derived(progressDraftValueToLbs(draftGoalWeight, progressDraftUnit));
  const hasUnsavedProgress = $derived.by(() => {
    const startChanged = draftStartWeightLbs === null
      ? progressBaseStartWeightLbs !== null
      : progressBaseStartWeightLbs === null ||
        Math.abs(draftStartWeightLbs - progressBaseStartWeightLbs) > 0.0001;
    const goalChanged = draftGoalWeightLbs === null
      ? progressBaseGoalWeightLbs !== null
      : progressBaseGoalWeightLbs === null ||
        Math.abs(draftGoalWeightLbs - progressBaseGoalWeightLbs) > 0.0001;
    return startChanged || goalChanged;
  });
  const hasUnsavedChanges = $derived(hasUnsavedProgress);

  type EfficacyRow = {
    week: number;
    doseDisplay: string;
    lossLbs: number | null;
    status: 'good' | 'warn' | 'no-data';
  };

  const efficacyMinLoss = $derived(lbsToDisplayNum('0.5', $weightUnit).toFixed(1));
  const efficacyMaxLoss = $derived(lbsToDisplayNum('1.5', $weightUnit).toFixed(1));

  const efficacyWarnTooltip = $derived(
    `Weekly loss is outside the healthy range of ${efficacyMinLoss}–${efficacyMaxLoss} ${$weightUnit}/week.`,
  );

  const efficacyHelpTooltip = $derived(
    [
      "Weekly loss = previous week's last weight − this week's last weight.",
      '',
      `✓  On track (${efficacyMinLoss}–${efficacyMaxLoss} ${$weightUnit}/week)`,
      `⚠  Outside healthy range`,
      '—  No weight data for this week',
    ].join('\n'),
  );

  function isoAddDays(iso: string, n: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d + n);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  const efficacyRows = $derived.by((): EfficacyRow[] => {
    const weightRows = sortedHealthRows.filter(
      (r) => r.weight !== '' && Number.isFinite(parseFloat(r.weight)),
    );
    if (weightRows.length < 2) return [];

    const anchor = weightRows[0].date;
    const rows: EfficacyRow[] = [];
    let prevWeightLbs: number = parseFloat(weightRows[0].weight);

    for (let week = 1; week <= 52; week++) {
      const windowStart = isoAddDays(anchor, (week - 1) * 7);
      const windowEnd = isoAddDays(anchor, week * 7);

      const weekWeightRows = weightRows.filter((r) => r.date > windowStart && r.date <= windowEnd);
      const weekDoseRows = sortedHealthRows.filter(
        (r) => r.dose !== '' && !r.doseSkipped && r.date > windowStart && r.date <= windowEnd,
      );

      if (weekWeightRows.length === 0 && weekDoseRows.length === 0) break;

      const lastWeightRow = weekWeightRows[weekWeightRows.length - 1];
      const lastWeightLbs = lastWeightRow ? parseFloat(lastWeightRow.weight) : null;

      const lastDoseRow = weekDoseRows[weekDoseRows.length - 1];
      const doseDisplay = lastDoseRow?.dose ? `${parseFloat(lastDoseRow.dose)} mg` : '';

      const lossLbs = lastWeightLbs !== null ? prevWeightLbs - lastWeightLbs : null;
      if (lastWeightLbs !== null) prevWeightLbs = lastWeightLbs;

      const status: EfficacyRow['status'] =
        lossLbs === null ? 'no-data' : lossLbs >= 0.5 && lossLbs <= 1.5 ? 'good' : 'warn';

      rows.push({ week, doseDisplay, lossLbs, status });
    }

    return rows.reverse();
  });

  function toggleGraphSeries(key: GraphSeriesKey) {
    if (hiddenGraphSeries.has(key)) {
      hiddenGraphSeries.delete(key);
      if (key === 'weight') hiddenGraphSeries.delete('weightPrediction');
    } else {
      hiddenGraphSeries.add(key);
      if (key === 'weight') hiddenGraphSeries.add('weightPrediction');
    }
  }

  $effect(() => {
    const nextStartWeight = $startWeight;
    const nextGoalWeight = $goalWeight;
    const nextUnit = $weightUnit;
    if (hasUnsavedProgress) return;

    progressBaseStartWeightLbs = nextStartWeight;
    progressBaseGoalWeightLbs = nextGoalWeight;
    syncProgressDraftsFromSaved(nextStartWeight, nextGoalWeight, nextUnit);
  });

  $effect(() => {
    const nextUnit = $weightUnit;
    if (progressDraftUnit === nextUnit) return;

    const startLbs = progressDraftValueToLbs(draftStartWeight, progressDraftUnit);
    const goalLbs = progressDraftValueToLbs(draftGoalWeight, progressDraftUnit);
    draftStartWeight = lbsToDraftInput(startLbs, nextUnit);
    draftGoalWeight = lbsToDraftInput(goalLbs, nextUnit);
    progressDraftUnit = nextUnit;
  });

  function progressDraftValueToLbs(value: number | string, unit: WeightUnit): number | null {
    if (value === '' || value === null) return null;
    const n = parseFloat(toStoredLbs(String(value), unit));
    return Number.isFinite(n) ? n : null;
  }

  function lbsToDraftInput(lbs: number | null, unit: WeightUnit): number | '' {
    if (lbs == null) return '';
    const n = lbsToDisplayNum(String(lbs), unit);
    return Number.isFinite(n) ? n : '';
  }

  function getInitialDiscardSignal(): number {
    return discardSignal;
  }

  function syncProgressDraftsFromSaved(
    startWeightLbs: number | null = $startWeight,
    goalWeightLbs: number | null = $goalWeight,
    unit: WeightUnit = $weightUnit,
  ) {
    draftStartWeight = lbsToDraftInput(startWeightLbs, unit);
    draftGoalWeight = lbsToDraftInput(goalWeightLbs, unit);
    progressDraftUnit = unit;
  }

  // Progress fields auto-save on commit now (the inputs-table model), so the
  // only remaining "discard unsaved" path is reverting an in-progress edit.
  function discardProgressEdits() {
    progressBaseStartWeightLbs = $startWeight;
    progressBaseGoalWeightLbs = $goalWeight;
    syncProgressDraftsFromSaved();
    progressGrid.editing = false;
  }

  function handleProgressCommitKeydown(event: KeyboardEvent) {
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

    if (!(event.target instanceof Node)) return;

    // Legend toggles save live, so Enter just closes edit mode.
    if (isEditingLegend && legendRegion?.contains(event.target)) {
      event.preventDefault();
      isEditingLegend = false;
    }
  }

  function requestInputRow() {
    addInputRowSignal += 1;
  }

  function toggleInputSettings() {
    inputSettingsOpen = !inputSettingsOpen;
  }
</script>

<svelte:document onkeydown={handleProgressCommitKeydown} />

<main class="content">
  <section class="panel-grid">
    <article class="card chart-card">
      <div class="chip-row">
        <h2 class="section-chip">Overview</h2>
        <EditPencil
          ariaLabel="Edit graph legend"
          active={isEditingLegend}
          onclick={() => (isEditingLegend = !isEditingLegend)}
        />
        {#if !isNarrowView}
          <div class="x-range-selector" role="group" aria-label="Graph time range">
            {#each X_RANGE_PRESETS as preset (preset.key)}
              <button
                type="button"
                class="x-range-btn"
                class:active={xRangeChoice === preset.key}
                aria-pressed={xRangeChoice === preset.key}
                onclick={() => selectXRange(preset.key)}
              >
                {preset.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="graph-legend" aria-label="Graph legend" bind:this={legendRegion}>
        {#each legendItems as item (item.key)}
          {#if (isEditingLegend || !item.hidden) && (item.key !== 'weightPrediction' || !hiddenGraphSeries.has('weight'))}
            <label class={['legend-item', { editing: isEditingLegend }]}>
              <span class={['legend-visual', { muted: item.hidden }]}>
                {#if item.shape}
                  <svg
                    class="swatch-system-svg"
                    viewBox="-14 -5 28 10"
                    aria-hidden="true"
                  >
                    <line x1="-14" x2="14" y1="0" y2="0" style:stroke={item.color} stroke-width="3" stroke-linecap="round"/>
                    <path d={shapePath(item.shape)} style:fill={item.color} style:stroke="var(--surface)" stroke-width="1.2"/>
                  </svg>
                {:else}
                  <span class={item.className} style:--swatch-color={item.color}></span>
                {/if}
                <span>{item.label}</span>
              </span>
              {#if isEditingLegend}
                <input
                  type="checkbox"
                  checked={!item.hidden}
                  onchange={() => toggleGraphSeries(item.key)}
                />
              {/if}
            </label>
          {/if}
        {/each}
      </div>
      <div class="plot-wrap">
        <!-- Fixed left axis -->
        {#if showAnyAxis}
        <svg
          class="axis-svg"
          viewBox={`0 0 ${CHART.margin.left} ${CHART.height}`}
          aria-hidden="true"
        >
          <g class="axes">
            <line x1={CHART.margin.left - 1} x2={CHART.margin.left - 1} y1={PLOT.top} y2={PLOT.bottom} />
          </g>
          <g class="axis-labels">
            {#each effectiveLeftTicks as tick (tick.value)}
              <text x={CHART.margin.left - 6} y={tick.y + 4} text-anchor="end">{tick.label}</text>
            {/each}
            <text
              class="axis-title left-title"
              x={16}
              y={(PLOT.top + PLOT.bottom) / 2}
              transform={`rotate(-90 16 ${(PLOT.top + PLOT.bottom) / 2})`}
              text-anchor="middle"
            >
              {effectiveLeftLabel}
            </text>
          </g>

          {#if crosshairActive && hoverY !== null && hoverValueLeft !== null}
            <line
              class="crosshair horizontal"
              x1={0}
              x2={CHART.margin.left}
              y1={hoverY}
              y2={hoverY}
            />
            <g class="crosshair-chip left">
              <rect
                x={CHART.margin.left - 2 - leftChipW}
                y={hoverY - 9}
                width={leftChipW}
                height={18}
                rx="3"
                ry="3"
              />
              <text
                bind:this={leftChipTextEl}
                x={CHART.margin.left - 7}
                y={hoverY}
                dy="0.35em"
                text-anchor="end"
              >
                {leftChipLabel}
              </text>
            </g>
          {/if}
        </svg>
        {/if}

        <!-- Scrollable data area -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="data-scroll"
          use:attachViewportObserver
          onmousemove={onPlotMouseMove}
          onmouseleave={clearCrosshair}
          onpointerdown={onPlotPointerDown}
          onpointerup={onPlotPointerUp}
        >
          <svg
            class="data-svg"
            viewBox={`${CHART.margin.left} 0 ${chartModel.plotWidth} ${CHART.height}`}
            style:width={`${chartModel.plotWidth}px`}
            role="img"
            aria-label="Health graph with weight, medication in system, wellness, and symptoms over time"
          >
            <defs>
              <clipPath id="health-chart-clip">
                <!-- Extend the clip a few px below the baseline so dose markers
                     sitting at 0mg (on the x-axis) aren't sliced in half. -->
                <rect x={PLOT.left} y={PLOT.top} width={chartModel.plotWidth} height={PLOT.height + 6} />
              </clipPath>
            </defs>

            <rect class="plot-bg" x={PLOT.left} y={PLOT.top} width={chartModel.plotWidth} height={PLOT.height} />

            {#if showAnyAxis}
              <g class="grid-lines">
                {#each effectiveLeftTicks as tick (tick.value)}
                  <line
                    x1={PLOT.left}
                    x2={chartModel.plotRight}
                    y1={tick.y}
                    y2={tick.y}
                  />
                {/each}
              </g>
            {/if}

            {#if chartModel.todayX !== null}
              <line
                class="today-line"
                x1={chartModel.todayX}
                x2={chartModel.todayX}
                y1={PLOT.top}
                y2={PLOT.bottom}
              />
            {/if}

            <!-- x-axis baseline drawn before the data so markers (especially
                 0mg dose dots on the axis) paint on top of it, not behind. -->
            <g class="axes">
              <line x1={PLOT.left} x2={chartModel.plotRight} y1={PLOT.bottom} y2={PLOT.bottom} />
            </g>

            <g clip-path="url(#health-chart-clip)">
              {#if !hiddenGraphSeries.has('wellness')}
                {#each chartModel.wellnessStacks as stack (stack.date)}
                  {#if stack.blocks.length}
                    <g role="img" aria-label={`Wellness ${stack.value} on ${stack.date}${stack.planned ? ' (planned)' : ''}`}>
                      {#each stack.blocks as block (block.index)}
                        <rect
                          class="wellness-bar"
                          class:planned={stack.planned}
                          x={block.x}
                          y={block.y}
                          width={block.width}
                          height={block.height}
                        />
                      {/each}
                    </g>
                  {/if}
                {/each}
              {/if}

              {#each chartModel.systemSeries as series (series.key)}
                {#if !hiddenGraphSeries.has(series.key)}
                  <path d={series.actualPath} class="system-line" style:--system-color={series.color} />
                  <path d={series.predictionPath} class="system-line dashed" style:--system-color={series.color} />
                  {#each series.dosePoints as dot (dot.date)}
                    <path
                      class="dose-point"
                      role="img"
                      aria-label={doseTooltipText(dot)}
                      d={shapePath(series.shape)}
                      transform={`translate(${dot.x} ${dot.y})`}
                      style:--system-color={series.color}
                      onmouseenter={() => (hoverDose = {
                        label: doseTooltipText(dot),
                        color: series.color,
                        x: dot.x,
                        y: dot.y,
                      })}
                      onmouseleave={() => (hoverDose = null)}
                      onpointerdown={(e) => showDoseTooltipOnTouch(e, {
                        label: doseTooltipText(dot),
                        color: series.color,
                        x: dot.x,
                        y: dot.y,
                      })}
                    />
                  {/each}
                  {#each series.plannedDosePoints as dot (dot.date)}
                    <path
                      class="dose-point planned"
                      role="img"
                      aria-label={`${doseTooltipText(dot)} (planned)`}
                      d={shapePath(series.shape)}
                      transform={`translate(${dot.x} ${dot.y})`}
                      style:--system-color={series.color}
                      onmouseenter={() => (hoverDose = {
                        label: `${doseTooltipText(dot)} (planned)`,
                        color: series.color,
                        x: dot.x,
                        y: dot.y,
                      })}
                      onmouseleave={() => (hoverDose = null)}
                      onpointerdown={(e) => showDoseTooltipOnTouch(e, {
                        label: `${doseTooltipText(dot)} (planned)`,
                        color: series.color,
                        x: dot.x,
                        y: dot.y,
                      })}
                    />
                  {/each}
                {/if}
              {/each}

              {#if !hiddenGraphSeries.has('weight')}
                <polyline points={chartModel.weightActualPath} class="weightline" />
                <polyline points={chartModel.weightFuturePath} class="weightline dashed" />
                {#each chartModel.weightPoints as point (point.date)}
                  <circle class="weight-point" class:planned={point.planned} cx={point.x} cy={point.y} r="3.2" />
                {/each}
              {/if}

              {#if !hiddenGraphSeries.has('weightPrediction') && !hiddenGraphSeries.has('weight')}
                <polyline points={chartModel.weightPredictionPath} class="weightline dashed" />
              {/if}
            </g>

            {#if !hiddenGraphSeries.has('symptoms')}
              <g class="symptom-layer">
                {#each chartModel.symptomStacks as stack (stack.date)}
                  <g>
                    {#each stack.items as item (item.symptom)}
                      <circle
                        class="symptom-dot"
                        cx={stack.x}
                        cy={item.y}
                        r="7.5"
                        fill={item.color}
                      />
                      <text class="symptom-letter" x={stack.x} y={item.y} dy="0.35em">{item.letter}</text>
                    {/each}
                  </g>
                {/each}
              </g>
            {/if}

            <g class="axis-labels">
              {#each chartModel.dateTicks as tick (tick.date)}
                <line
                  class="date-tick"
                  class:active={hoverDate === tick.date}
                  x1={tick.x}
                  x2={tick.x}
                  y1={PLOT.bottom}
                  y2={PLOT.bottom + 6}
                />
                <text
                  class="date-label"
                  class:active={hoverDate === tick.date}
                  x={tick.x}
                  y={PLOT.bottom + 8}
                  transform={`rotate(-90 ${tick.x} ${PLOT.bottom + 8})`}
                  text-anchor="end"
                  dominant-baseline="central"
                >
                  {tick.label}
                </text>
              {/each}
            </g>

            <!-- Crosshair: vertical line snapped to nearest day, horizontal at
                 cursor y. The vertical line gets an extra date label below the
                 axis when it lands between decimated ticks. -->
            {#if crosshairActive && hoverDate && hoverY !== null}
              {@const xhX = chartModel.cssXForDate(hoverDate) + CHART.margin.left}
              <line
                class="crosshair vertical"
                x1={xhX}
                x2={xhX}
                y1={PLOT.top}
                y2={PLOT.bottom}
              />
              <line
                class="crosshair horizontal"
                x1={PLOT.left}
                x2={chartModel.plotRight}
                y1={hoverY}
                y2={hoverY}
              />
              {#if !chartModel.dateTicks.some((t) => t.date === hoverDate)}
                <text
                  class="date-label active"
                  x={xhX}
                  y={PLOT.bottom + 8}
                  transform={`rotate(-90 ${xhX} ${PLOT.bottom + 8})`}
                  text-anchor="end"
                  dominant-baseline="central"
                >
                  {hoverDate.slice(5).replace('-', '/').replace(/^0/, '')}
                </text>
              {/if}
            {/if}

            <!-- Dose tooltip: small chip rendered inside the data-svg so it
                 scrolls with content. -->
            {#if hoverDose}
              {@const tw = Math.max(40, hoverDose.label.length * 6.2 + 14)}
              {@const th = 18}
              {@const tx = Math.min(
                Math.max(hoverDose.x - tw / 2, PLOT.left + 2),
                chartModel.plotRight - tw - 2,
              )}
              {@const ty = Math.max(hoverDose.y - th - 12, PLOT.top + 2)}
              <g class="dose-tooltip" pointer-events="none">
                <rect
                  x={tx}
                  y={ty}
                  width={tw}
                  height={th}
                  rx="4"
                  ry="4"
                  style:--system-color={hoverDose.color}
                />
                <text x={tx + tw / 2} y={ty + th / 2} dy="0.35em" text-anchor="middle">
                  {hoverDose.label}
                </text>
              </g>
            {/if}

            {#if !chartModel.hasAnyData}
              <text class="empty-chart" x={CHART.width / 2} y={(PLOT.top + PLOT.bottom) / 2} text-anchor="middle">
                Add a weight, dose, wellness score, or symptom to start the graph.
              </text>
            {/if}
          </svg>
        </div>

        <!-- Fixed right axis -->
        {#if showAnyAxis}
          <svg
            class="axis-svg"
            viewBox={`0 0 ${CHART.margin.right} ${CHART.height}`}
            aria-hidden="true"
          >
            <g class="axes">
              <line x1={1} x2={1} y1={PLOT.top} y2={PLOT.bottom} />
            </g>
            <g class="axis-labels">
              {#each effectiveRightTicks as tick (tick.value)}
                <text x={5} y={tick.y + 4}>{tick.label}</text>
              {/each}
              <text
                class="axis-title right-title"
                x={CHART.margin.right - 16}
                y={(PLOT.top + PLOT.bottom) / 2}
                transform={`rotate(90 ${CHART.margin.right - 16} ${(PLOT.top + PLOT.bottom) / 2})`}
                text-anchor="middle"
              >
                {effectiveRightLabel}
              </text>
            </g>

            {#if crosshairActive && hoverY !== null && hoverValueRight !== null}
              <line
                class="crosshair horizontal"
                x1={0}
                x2={CHART.margin.right}
                y1={hoverY}
                y2={hoverY}
              />
              <g class="crosshair-chip right">
                <rect
                  x={2}
                  y={hoverY - 9}
                  width={rightChipW}
                  height={18}
                  rx="3"
                  ry="3"
                />
                <text bind:this={rightChipTextEl} x={7} y={hoverY} dy="0.35em" text-anchor="start">
                  {rightChipLabel}
                </text>
              </g>
            {/if}
          </svg>
        {/if}
      </div>
    </article>

    <div class="right-col">
      <article class="card">
        <h2 class="section-chip">Efficacy</h2>
        <div class="efficacy-scroll">
          <table class="mini-table">
            <thead>
              <tr>
                <th>Week</th>
                <th>Dose Amount</th>
                <th>Weekly Loss</th>
                <th class="status-th">
                  <HelpBadge tooltip={efficacyHelpTooltip} />
                </th>
              </tr>
            </thead>
            <tbody>
              {#each efficacyRows as row (row.week)}
                <tr>
                  <td>{row.week}</td>
                  <td>{row.doseDisplay}</td>
                  <td>
                    {#if row.lossLbs !== null}
                      {lbsToDisplayNum(String(row.lossLbs), $weightUnit).toFixed(1)}
                      {$weightUnit}
                    {:else}
                      —
                    {/if}
                  </td>
                  <td>
                    {#if row.status === 'good'}
                      <span class="status success">✓</span>
                    {:else if row.status === 'warn'}
                      <WarnBadge tooltip={efficacyWarnTooltip} />
                    {:else}
                      <span>—</span>
                    {/if}
                  </td>
                </tr>
              {:else}
                <tr>
                  <td colspan="4" class="empty-efficacy">No data yet</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </article>

      <article class="card" bind:this={progressCardRegion}>
        <div class="chip-row">
          <h2 class="section-chip">Progress</h2>
        </div>
        <table class="kv-table">
          <tbody>
            <tr>
              <th>Start Weight</th>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <td
                data-cell="0-0"
                class="kv-cell"
                title="Click to edit"
                tabindex={progressGrid.tabIndexFor(0, 0, true)}
                class:cell-editing={progressGrid.isCellEditing(0, 0)}
                onclick={() => progressGrid.selectCell(0, 0, true)}
                onkeydown={(e) => progressGrid.cellKeydown(e, 0, 0)}
              >
                {#if progressGrid.isCellEditing(0, 0)}
                  <input
                    class="progress-input cell-input"
                    type="number"
                    min="0"
                    step="any"
                    bind:value={draftStartWeight}
                    onkeydown={progressGrid.editorKeydown}
                    onblur={() => {
                      commitProgressFields();
                      progressGrid.stopEditing();
                    }}
                  />
                {:else if startWeightDisplay != null}
                  {startWeightDisplay.toFixed(1)} {$weightUnit}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
            <tr>
              <th>Current Weight</th>
              <td>
                {#if currentWeightDisplay != null}
                  {currentWeightDisplay.toFixed(1)} {$weightUnit}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
            <tr>
              <th>Goal Weight</th>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <td
                data-cell="2-0"
                class="kv-cell"
                title="Click to edit"
                tabindex={progressGrid.tabIndexFor(2, 0, false)}
                class:cell-editing={progressGrid.isCellEditing(2, 0)}
                onclick={() => progressGrid.selectCell(2, 0, true)}
                onkeydown={(e) => progressGrid.cellKeydown(e, 2, 0)}
              >
                {#if progressGrid.isCellEditing(2, 0)}
                  <input
                    class="progress-input cell-input"
                    type="number"
                    min="0"
                    step="any"
                    bind:value={draftGoalWeight}
                    onkeydown={progressGrid.editorKeydown}
                    onblur={() => {
                      commitProgressFields();
                      progressGrid.stopEditing();
                    }}
                  />
                {:else if goalWeightDisplay != null}
                  {goalWeightDisplay.toFixed(1)} {$weightUnit}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
            <tr>
              <th>To Goal</th>
              <td>
                {#if weightToGoal != null}
                  {weightToGoal.toFixed(1)} {$weightUnit}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
            <tr>
              <th>% Loss</th>
              <td>
                {#if percentLoss != null}
                  {percentLoss.toFixed(1)}%
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
            <tr>
              <th>Cost per {unitLabel}</th>
              <td>
                {#if costPerUnit != null}
                  ${costPerUnit.toFixed(2)}
                {:else}
                  <span class="empty-value">--</span>
                {/if}
              </td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  </section>

  <article class="card inputs-card">
    <div class="chip-row">
      <h2 class="section-chip">Inputs</h2>
      <button
        type="button"
        class="icon-action add-row-button"
        aria-label="Add input row"
        onclick={requestInputRow}
      >
        +
      </button>
      <button
        type="button"
        class={['settings-btn', { active: inputSettingsOpen }]}
        aria-label={inputSettingsOpen ? 'Hide input table settings' : 'Show input table settings'}
        title={inputSettingsOpen ? 'Hide input table settings' : 'Show input table settings'}
        aria-pressed={inputSettingsOpen}
        onclick={toggleInputSettings}
      >
        <GearIcon size="60%" color="white" />
      </button>
    </div>
    <div class="inputs-panel">
      <InputsTable
        rows={$healthEntries}
        isSettingsOpen={inputSettingsOpen}
        addRowSignal={addInputRowSignal}
      />
    </div>
  </article>
</main>

<style>
  .content {
    width: min(100% - 2rem, 1240px);
    margin-inline: auto;
    padding: 1rem 0 1.25rem;
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  /* Grid items default to min-width:auto (min-content); without this the wide
   * inputs table inside .inputs-card pushes the page past the viewport instead
   * of scrolling inside its own .table-scroll wrapper. */
  .content > * {
    min-width: 0;
  }

  .panel-grid {
    --weight-color: var(--weightLine);
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(0, 0.95fr);
    gap: 1rem;
    align-items: stretch;
  }

  .card {
    border: 1px solid var(--cardBorder);
    border-radius: 14px;
    background: color-mix(in oklab, var(--bgTint) 18%, white 82%);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.16);
    padding: 0.75rem;
  }

  .chart-card,
  .right-col {
    min-width: 0;
  }

  .chip-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.35rem;
  }

  /* The Overview range selector can be wider than the room left on one line at
   * smaller desktop widths; let it wrap below rather than push the card sideways
   * (margin-left:auto keeps it right-aligned on its own line). */
  .chart-card .chip-row {
    flex-wrap: wrap;
    row-gap: 0.4rem;
  }

  .x-range-selector {
    margin-left: auto;
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1.5px solid var(--cardBorder);
    border-radius: 8px;
    background: color-mix(in oklab, var(--surface) 70%, transparent);
    color: var(--text);
  }

  .x-range-btn {
    border: 0;
    background: transparent;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    padding: 0.2rem 0.55rem;
    border-radius: 6px;
    cursor: pointer;
    line-height: 1;
    color: color-mix(in oklab, var(--text) 65%, transparent);
  }

  .x-range-btn:hover {
    background: color-mix(in oklab, var(--text) 10%, transparent);
    color: var(--text);
  }

  .x-range-btn.active {
    background: var(--headerBg);
    color: var(--headerText);
  }

  .icon-action {
    cursor: pointer;
  }

  .add-row-button {
    border: 0;
    /* Flat bottom so the action buttons read as tabs alongside the section
     * chip (see .section-chip). */
    border-radius: 10px 10px 0 0;
    width: 2rem;
    height: 2rem;
    padding: 0;
    margin-left: 0.1rem;
    background: color-mix(in oklab, var(--headerBg) 88%, white 12%);
    color: var(--headerText);
    font-size: 1.15rem;
    font-weight: 600;
    line-height: 0;
    display: inline-grid;
    place-items: center;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cardBorder) 16%, transparent 84%);
  }

  .settings-btn {
    border: 0;
    border-radius: 10px 10px 0 0;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: color-mix(in oklab, var(--headerBg) 88%, white 12%);
    line-height: 0;
    cursor: pointer;
    color: var(--headerText);
    display: inline-grid;
    place-items: center;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cardBorder) 16%, transparent 84%);
  }

  .settings-btn.active {
    background: color-mix(in oklab, var(--headerBg) 96%, #f2ca67 4%);
  }

  /* The EditPencil child component is a pill by default; in every health-tab
   * chip row it takes the same flat-bottom tab shape as the section chip. */
  .chip-row :global(.edit-pencil) {
    border-radius: 10px 10px 0 0;
  }


  .chip,
  .section-chip {
    border: 1px solid var(--cardBorder);
    border-bottom-width: 0;
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
    background: color-mix(in oklab, var(--headerBg) 92%, white 8%);
    color: var(--headerText);
    font-size: 1.1rem;
    font-weight: 700;
    font-variant: small-caps;
    line-height: 1;
    padding: 0.45rem 0.85rem 0.5rem;
    margin: 0;
  }

  .chip {
    cursor: pointer;
    opacity: 0.9;
  }

  .chip.active {
    opacity: 1;
  }

  .graph-legend {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.35rem 0.65rem;
    margin-bottom: 0.35rem;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    border-radius: 7px;
  }

  .legend-item.editing {
    cursor: pointer;
    padding: 0.22rem 0.4rem 0.22rem 0.38rem;
    border: 1.5px solid color-mix(in oklab, var(--cardBorder) 50%, transparent 50%);
    background: color-mix(in oklab, var(--surface) 55%, transparent);
  }

  .legend-visual {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
  }

  .legend-visual.muted {
    opacity: 0.38;
  }

  .legend-item input[type='checkbox'] {
    margin: 0;
    flex-shrink: 0;
    accent-color: var(--accent);
    cursor: pointer;
    width: 0.9rem;
    height: 0.9rem;
  }

  .swatch-line {
    width: 1.5rem;
    height: 0;
    border-top: 1px solid var(--accent);
    display: inline-block;
  }

  .swatch-weight,
  .swatch-weight-prediction {
    border-top-color: var(--weight-color);
  }

  .swatch-weight-prediction {
    border-top-style: dashed;
  }

  .swatch-system {
    border-top-color: var(--swatch-color, var(--accent));
  }

  .swatch-system-svg {
    width: 1.85rem;
    height: 0.7rem;
    overflow: visible;
    display: inline-block;
    flex-shrink: 0;
  }

  .swatch-bar {
    width: 0.62rem;
    height: 0.9rem;
    border-radius: 3px 3px 0 0;
    background: var(--wellnessBar);
    display: inline-block;
  }

  .swatch-dot {
    width: 0.72rem;
    height: 0.72rem;
    border-radius: 999px;
    background: var(--symptomMarker);
    display: inline-block;
  }

  .plot-wrap {
    padding: 0.25rem 0 0;
    /* Bleed into the card's 0.75rem padding so the axis titles sit ~0.3rem from
     * the card edge and the freed width goes to the plot. */
    margin-inline: -0.45rem;
    width: auto;
    display: flex;
    align-items: flex-start;
    /* visible (not hidden) so the crosshair value chips can spill past the
     * narrow axis gutters — and the card — to show their full text. The
     * scrolling plot area is clipped by .data-scroll's own overflow, not this. */
    overflow: visible;
  }

  .axis-svg {
    flex-shrink: 0;
    display: block;
    height: 440px;
    max-width: none;
    /* Let the crosshair chip render outside the gutter's width. */
    overflow: visible;
  }

  .data-scroll {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .data-svg {
    display: block;
    height: 440px;
    max-width: none;
  }

  .plot-bg {
    fill: color-mix(in oklab, var(--surface) 68%, transparent);
  }

  .grid-lines line {
    stroke: color-mix(in oklab, var(--cardBorder) 36%, #c5c5c5 64%);
    stroke-width: 1;
  }

  .axes line,
  .date-tick {
    stroke: color-mix(in oklab, var(--cardBorder) 64%, #707070 36%);
    stroke-width: 1.4;
  }

  .weightline {
    fill: none;
    stroke: var(--weight-color);
    stroke-width: 4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .system-line {
    fill: none;
    stroke: var(--system-color, var(--accent));
    stroke-width: 3.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dashed {
    stroke-dasharray: 8 7;
  }

  .weight-point {
    fill: var(--weight-color);
    stroke: var(--surface);
    stroke-width: 1.5;
  }

  .weight-point.planned {
    fill: var(--surface);
    stroke: var(--weight-color);
    stroke-width: 1.5;
  }

  .dose-point {
    fill: var(--system-color, var(--accent));
    stroke: var(--surface);
    stroke-width: 1.5;
  }

  .dose-point.planned {
    fill: var(--surface);
    stroke: var(--system-color, var(--accent));
    stroke-width: 1.5;
  }

  .wellness-bar {
    fill: color-mix(in oklab, var(--wellnessBar) 78%, white 22%);
    opacity: 0.72;
  }

  .wellness-bar.planned {
    fill: none;
    stroke: color-mix(in oklab, var(--wellnessBar) 78%, white 22%);
    stroke-width: 1.5;
    stroke-dasharray: 3 2;
    opacity: 0.85;
  }

  .today-line {
    stroke: color-mix(in oklab, var(--text) 55%, transparent 45%);
    stroke-width: 1.2;
    stroke-dasharray: 4 5;
    opacity: 0.7;
  }

  .symptom-dot {
    stroke: color-mix(in oklab, var(--text) 45%, transparent 55%);
    stroke-width: 1;
  }

  .symptom-letter {
    fill: var(--text);
    font-size: 0.58rem;
    font-weight: 800;
    text-anchor: middle;
    pointer-events: none;
  }

  .axis-labels text {
    fill: color-mix(in oklab, var(--text) 78%, transparent 22%);
    font-size: 0.72rem;
  }

  .axis-labels .axis-title {
    font-size: 0.78rem;
    font-weight: 800;
    fill: var(--text);
  }

  .date-label {
    font-weight: 650;
  }

  .date-tick.active {
    stroke: var(--text);
    stroke-width: 2;
  }

  .date-label.active {
    fill: var(--text);
    font-weight: 800;
  }

  /* Crosshair lines: dotted, subtle, ignore pointer so they don't block hover
     events on the underlying data points. */
  .crosshair {
    stroke: color-mix(in oklab, var(--text) 70%, transparent 30%);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    pointer-events: none;
  }

  /* Axis value chips that appear at each end of the horizontal crosshair. */
  .crosshair-chip rect {
    fill: var(--headerBg);
    opacity: 0.95;
  }
  .crosshair-chip text {
    fill: var(--headerText);
    font-size: 0.72rem;
    font-weight: 700;
  }

  /* Dose-marker tooltip rendered inside the data-svg. */
  .dose-tooltip rect {
    fill: var(--surface);
    stroke: var(--system-color, var(--accent));
    stroke-width: 1.5;
  }
  .dose-tooltip text {
    fill: var(--text);
    font-size: 0.74rem;
    font-weight: 700;
  }

  /* Dose dots: cursor + grow-on-hover so the affordance is clear. */
  .dose-point {
    cursor: pointer;
  }
  .dose-point:hover {
    stroke-width: 2.2;
  }

  .empty-chart {
    fill: color-mix(in oklab, var(--text) 65%, transparent 35%);
    font-size: 0.9rem;
    font-weight: 700;
  }

  .right-col {
    display: grid;
    gap: 1rem;
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

  .efficacy-scroll {
    overflow-y: auto;
    /* header row + 5 body rows at ~2.5rem each */
    max-height: calc(6 * 2.5rem);
  }

  .mini-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: color-mix(in oklab, var(--headerBg) 60%, white 40%);
    color: var(--headerText);
  }

  .mini-table td,
  .mini-table th {
    text-align: center;
  }

  .mini-table .status-th {
    cursor: help;
    line-height: 0;
  }

  .mini-table tbody tr:nth-child(even),
  .kv-table tbody tr:nth-child(even) {
    background: var(--rowAlt);
  }

  .status {
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
    color: var(--headerText);
  }

  .empty-efficacy {
    text-align: center;
    color: var(--text-secondary);
    padding: 0.75rem;
  }

  .status.success {
    background: var(--success);
  }

  .kv-table th {
    font-weight: 500;
    text-align: left;
  }

  .kv-table td {
    text-align: right;
    font-weight: 600;
  }

  /* Editable progress cells share the inputs-table two-state look. A faint
     always-on affordance signals they're editable; a selection ring shows while
     the cell is focused, and a stronger inner shadow while editing. The ring is
     driven by real :focus so it disappears when focus leaves (only one selector
     on the page at a time). */
  .kv-table td.kv-cell {
    position: relative;
    cursor: pointer;
    border-radius: 6px;
    outline: none;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cardBorder) 45%, transparent);
  }
  .kv-table td.kv-cell:hover {
    background: color-mix(in oklab, var(--accent) 8%, transparent);
  }
  .kv-table td.kv-cell:focus {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .kv-table td.kv-cell.cell-editing {
    box-shadow:
      inset 0 0 0 2.5px color-mix(in oklab, var(--accent) 30%, var(--text) 70%),
      inset 0 0 18px 4px color-mix(in oklab, var(--accent) 60%, transparent);
  }

  .progress-input {
    width: 6.5rem;
    border: 1px solid color-mix(in oklab, var(--cardBorder) 60%, white 40%);
    border-radius: 8px;
    padding: 0.2rem 0.35rem;
    font: inherit;
    text-align: right;
  }
  /* When the input is the in-cell editor, drop its own chrome so the cell ring
     is the only indicator (matches the inputs table). It's overlaid absolutely
     so the cell keeps exactly the size of the static value in both modes — a
     `width:100%` number input still contributes its large default intrinsic
     width to the auto-sized column, which is what made the field grow on click.
     `inset:0` + matching padding makes the editor fill the same box without
     inflating the column. */
  .progress-input.cell-input {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    width: auto;
    border: 0;
    border-radius: 0;
    padding: 0.4rem 0.45rem;
    background: transparent;
    outline: none;
  }

  .empty-value {
    color: color-mix(in oklab, currentColor 45%, transparent);
  }

  .inputs-card {
    padding-top: 0.4rem;
  }

  /* Desktop only: nudge the inputs chip-row in slightly. On mobile the row
   * renders as card-tab chips flush to the edge, so the margin is left off. */
  @media (min-width: 641px) {
    .inputs-card .chip-row {
      margin-left: 0px;
    }
  }

  /* ── Inputs header chip-strip (mobile card view only) ──
   * On mobile the inputs table renders as stacked cards; the "Inputs" label and
   * every action button become rounded-top chips whose background extends a
   * "skirt" below the line (extra padding-bottom cancelled by an equal negative
   * margin, so the flex row's height is unchanged) and tucks behind the card
   * stack (which paints on top via .inputs-panel's z-index), so the chips read
   * as tabs on the cards. On desktop the table is flat, so that skirt would
   * instead spill below the chips and past the header — it's left off there and
   * the chips fall back to the same spaced-above look as the Overview/Progress
   * chips. */
  @media (max-width: 640px) {
    .inputs-card .chip-row {
      --tab-skirt: 1rem;
      align-items: stretch;
      gap: 0.3rem;
      margin-bottom: 0;
    }

    .inputs-card .section-chip {
      display: flex;
      align-items: center;
      padding-bottom: calc(0.5rem + var(--tab-skirt));
      margin-bottom: calc(-1 * var(--tab-skirt));
    }

    /* The inputs-card toolbar buttons take the chip shape: rounded-top, same
     * skirt, no pill shadow. height:auto lets them stretch to the section-chip's
     * height; the icon stays centred above the skirt (place-items:center).
     * NB: do NOT include the EditPencil here — the only `.edit-pencil`s inside
     * `.inputs-card` are the per-card edit buttons rendered by <InputsTable>, and
     * the tab shape would give them two rounded + two square corners. They keep
     * their own 2rem square. */
    .inputs-card .add-row-button,
    .inputs-card .settings-btn {
      height: auto;
      border-radius: 12px 12px 0 0;
      padding: 0 0 var(--tab-skirt);
      margin-bottom: calc(-1 * var(--tab-skirt));
      box-shadow: none;
    }
  }

  /* Sits above the chip strip so the cards always cover the chips' skirts. */
  .inputs-panel {
    position: relative;
    z-index: 1;
  }

  @media (max-width: 1280px) {
    table {
      font-size: 1rem;
    }
  }

  @media (max-width: 1024px) {
    .panel-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

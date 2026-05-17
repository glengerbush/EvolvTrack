<script module lang="ts">
  let syringeInstanceId = 0;
</script>

<script lang="ts">
  let {
    units,
    valid,
    label,
    ariaLabel = `Syringe diagram showing ${valid ? units.toFixed(1) : 0} of 100 units`
  } = $props<{
    units: number;
    valid: boolean;
    label: string;
    ariaLabel?: string;
  }>();

  const uid = `syringe-${++syringeInstanceId}`;

  // Barrel spans y=50-290 (240px = 100 units, 2.4px/unit).
  const BL = 38;
  const BR = 82;
  const BT = 50;
  const BB = 290;
  const BH = BB - BT;
  const NX = (BL + BR) / 2;
  const NY = 332;

  const majorMarks = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const minorMarks = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95];

  const clampedUnits = $derived(Math.max(0, Math.min(100, valid ? units : 0)));

  function markY(markUnits: number): number {
    return BB - (markUnits / 100) * BH;
  }

  const fillTop = $derived(valid ? markY(clampedUnits) : BB);
  const fillHeight = $derived(BB - fillTop);
</script>

<div class="syringe-col">
  <svg viewBox="0 0 125 365" role="img" aria-label={ariaLabel} class="syringe-svg">
    <defs>
      <clipPath id="bc-{uid}">
        <rect x={BL + 1} y={BT + 1} width={BR - BL - 2} height={BH - 2} />
      </clipPath>
    </defs>

    {#if valid && fillHeight > 0}
      <rect
        x={BL + 1}
        y={fillTop}
        width={BR - BL - 2}
        height={fillHeight}
        class="fill-rect"
        clip-path="url(#bc-{uid})"
      />
    {/if}

    {#if valid && clampedUnits > 0 && clampedUnits < 100}
      <rect
        x={BL + 1}
        y={fillTop - 5}
        width={BR - BL - 2}
        height="8"
        rx="2"
        class="stopper-rect"
      />
    {/if}

    <rect
      x={BL}
      y={BT}
      width={BR - BL}
      height={BH}
      rx="3"
      fill="none"
      stroke="var(--cardBorder)"
      stroke-width="2"
    />

    <rect
      x={BL - 16}
      y={BT}
      width="16"
      height="14"
      rx="2"
      class="flange-rect"
      stroke="var(--cardBorder)"
      stroke-width="2"
    />
    <rect
      x={BR}
      y={BT}
      width="16"
      height="14"
      rx="2"
      class="flange-rect"
      stroke="var(--cardBorder)"
      stroke-width="2"
    />

    <line x1={BL + 2} y1={BB} x2={BR - 2} y2={BB} class="erase-line" stroke-width="2" />

    <path
      d="M {BL},{BB} L {NX},{NY} L {BR},{BB}"
      class="needle-cone"
      stroke="var(--cardBorder)"
      stroke-width="2"
      stroke-linejoin="round"
    />

    <line
      x1={NX}
      y1={NY}
      x2={NX}
      y2={NY + 24}
      stroke="var(--cardBorder)"
      stroke-width="1.5"
    />

    {#each majorMarks as mark (mark)}
      {@const y = markY(mark)}
      <line x1={BR} y1={y} x2={BR + 16} y2={y} stroke="var(--cardBorder)" stroke-width="1.5" />
      <text x={BR + 19} y={y + 4} class="mark-label">{mark}</text>
    {/each}

    {#each minorMarks as mark (mark)}
      {@const y = markY(mark)}
      <line x1={BR} y1={y} x2={BR + 9} y2={y} stroke="var(--cardBorder)" stroke-width="1" />
    {/each}

    {#if valid && clampedUnits > 0}
      <line x1={BL - 2} y1={fillTop} x2={BL - 12} y2={fillTop} class="indicator-line" stroke-width="2" />
    {/if}
  </svg>

  <p class="syringe-label">{label}</p>
</div>

<style>
  .syringe-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .syringe-svg {
    width: 115px;
    height: auto;
    overflow: visible;
  }

  .fill-rect {
    fill: var(--accent);
    opacity: 0.28;
  }

  .stopper-rect {
    fill: color-mix(in oklab, var(--accent) 50%, white 50%);
    stroke: color-mix(in oklab, var(--accent) 75%, var(--cardBorder) 25%);
    stroke-width: 1;
  }

  .flange-rect {
    fill: color-mix(in oklab, var(--surface) 92%, transparent);
  }

  .erase-line {
    stroke: color-mix(in oklab, var(--surface) 92%, transparent);
  }

  .needle-cone {
    fill: color-mix(in oklab, var(--surface) 92%, transparent);
  }

  .mark-label {
    font-size: 10.5px;
    fill: #555;
  }

  .indicator-line {
    stroke: var(--accent);
  }

  .syringe-label {
    margin: 0;
    font-size: 0.88rem;
    color: var(--muted);
    text-align: center;
    font-weight: 500;
  }

  @media (max-width: 900px) {
    .syringe-col {
      flex-direction: row;
      gap: 1.5rem;
      align-items: flex-end;
    }

    .syringe-svg {
      width: 80px;
    }
  }
</style>

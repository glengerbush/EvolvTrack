<script lang="ts">
  let { amount, medication, status }: {
    amount: string;
    medication: string;
    status: 'taken' | 'planned' | 'skipped';
  } = $props();

  const label = $derived(status === 'skipped' ? 'Skipped dose' : status === 'planned' ? 'Planned dose' : 'Dose taken');
</script>

<div class="dose-summary" data-status={status}>
  <div class="dose-description">
    <div class="dose-status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        {#if status === 'skipped'}
          <circle cx="12" cy="12" r="9" />
          <path d="m6 18 12-12" />
        {:else if status === 'planned'}
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M7 3v4m10-4v4M3 11h18m-14 5h3" />
        {:else}
          <path d="m18 2 4 4m-5 1 3-3M19 9 8.7 19.3a1 1 0 0 1-.7.3H5v-3a1 1 0 0 1 .3-.7L15.6 5.6M2 22l3-3m3-7 4 4m1-13 8 8" />
        {/if}
      </svg>
      <span>{label}</span>
    </div>
    <div class="dose-medication" title={medication || 'This dose is not shown on the graph without a medication.'}>
      {medication || 'Medication not set'}
    </div>
  </div>
  <div class="dose-amount">{amount} <span class="dose-unit">mg</span></div>
</div>

<style>
  .dose-summary {
    --dose-tone: var(--success);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    width: 100%;
    padding: 0.65rem;
    border-radius: 7px;
    background: color-mix(in oklab, var(--dose-tone) 12%, var(--surface));
    color: color-mix(in oklab, var(--dose-tone) 40%, var(--text));
    text-align: left;
  }

  .dose-summary[data-status='planned'] { --dose-tone: var(--warning); }
  .dose-summary[data-status='skipped'] { --dose-tone: var(--muted); }

  .dose-description {
    flex: 1 1 8rem;
    min-width: 0;
  }

  .dose-status {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-weight: 700;
    font-size: 0.875rem;
  }

  svg { width: 1.1rem; height: 1.1rem; flex-shrink: 0; }

  .dose-medication {
    margin: 0.15rem 0 0 1.45rem;
    font-size: 0.75rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .dose-amount {
    margin-left: auto;
    font-size: 1.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .dose-unit { font-size: 0.8125rem; font-weight: 400; }
</style>

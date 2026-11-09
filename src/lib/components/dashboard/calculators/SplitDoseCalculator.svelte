<script lang="ts">
  import './calculator.css';
  import { formatSplitDose, intervalDose, twiceWeeklyDoses } from './splitDose';

  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  let weeklyMg = $state<number | undefined>(undefined);
  let mode = $state<'interval' | 'weekly'>('interval');
  let interval = $state<number | undefined>(5);
  let selectedDays = $state([0, 3]);

  const validFrequency = $derived(interval !== undefined && Number.isFinite(interval) && interval > 0);
  const dose = $derived(intervalDose(weeklyMg, interval));
  const weeklyDoses = $derived(twiceWeeklyDoses(weeklyMg, selectedDays));
  const validWeeklyDose = $derived(weeklyMg !== undefined && Number.isFinite(weeklyMg) && weeklyMg > 0);
  const modified = $derived(weeklyMg !== undefined || mode !== 'interval' || interval !== 5 ||
    selectedDays.length !== 2 || !selectedDays.includes(0) || !selectedDays.includes(3));

  function toggleDay(day: number) {
    selectedDays = selectedDays.includes(day)
      ? selectedDays.filter((selected) => selected !== day)
      : [...selectedDays.slice(-1), day];
  }

  function reset() {
    weeklyMg = undefined;
    mode = 'interval';
    interval = 5;
    selectedDays = [0, 3];
  }
</script>

<article class="calculator-card split-dose" aria-labelledby="split-dose-heading">
  <h2 id="split-dose-heading" class="calculator-heading">How do I <strong>split</strong> my weekly dose?</h2>
  <div class="calculator-body single-column">
    <div class="calculator-inputs">
      <p class="split-description">Convert a weekly amount into doses on a repeating schedule.</p>

      <div class="calculator-fields">
        <label class="calculator-field">
          <span class="calculator-field-label">Desired Weekly Dose</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={weeklyMg} min="0" step="any" placeholder="e.g. 5"
              aria-invalid={weeklyMg !== undefined && !validWeeklyDose} aria-describedby="split-dose-help" />
            <span class="calculator-field-unit">mg / week</span>
          </div>
        </label>
        <p id="split-dose-help" class="split-hint">Enter the total weekly amount agreed with your prescriber.</p>

        <fieldset class="split-controls">
          <legend class="calculator-field-label">Dosing Schedule</legend>
          <div class="calculator-button-row">
            <button type="button" class="calculator-primary-button" aria-pressed={mode === 'interval'}
              onclick={() => mode = 'interval'}>Every X days</button>
            <button type="button" class="calculator-primary-button" aria-pressed={mode === 'weekly'}
              onclick={() => mode = 'weekly'}>Twice weekly</button>
          </div>
        </fieldset>

        {#if mode === 'interval'}
          <label class="calculator-field">
            <span class="calculator-field-label">Days between doses</span>
            <div class="calculator-field-row">
              <span class="calculator-field-unit">Every</span>
              <input type="number" min="0" step="1" bind:value={interval}
                aria-label="Days between doses" aria-invalid={interval !== undefined && !validFrequency}
                aria-describedby="split-frequency-help" />
              <span class="calculator-field-unit">days</span>
            </div>
          </label>
          <p id="split-frequency-help" class="split-hint">Enter any number greater than zero, including decimals.</p>
        {:else}
          <fieldset class="split-controls">
            <legend class="calculator-field-label">Choose two injection days</legend>
            <div class="split-weekdays">
              {#each weekdays as day, index (day)}
                <button type="button" class="calculator-primary-button" aria-label={day}
                  aria-pressed={selectedDays.includes(index)} onclick={() => toggleDay(index)}>{day.slice(0, 3)}</button>
              {/each}
            </div>
          </fieldset>
          <p class="split-hint">Each dose is proportional to the days until your next injection, so the two amounts may differ.</p>
        {/if}

        {#if modified}
          <button type="button" class="calculator-reset-button" onclick={reset}>↺ Reset to defaults</button>
        {/if}
      </div>

      <div class="split-output" role="status" aria-live="polite" aria-atomic="true">
        {#if !validWeeklyDose}
          <p class="split-hint">Enter a weekly dose greater than zero to see your split doses.</p>
        {:else if mode === 'weekly' && selectedDays.length !== 2}
          <p class="split-hint">Select two different days to see your split doses.</p>
        {:else if mode === 'weekly' && weeklyDoses}
          <div class="calculator-math">
            {#each weeklyDoses as item (item.day)}
              <div class="calculator-math-row">
                <span class="calculator-math-label">{weekdays[item.day]}</span>
                <span class="calculator-math-equals">=</span>
                <span class="calculator-math-value">{weeklyMg} mg ÷ 7 × {item.daysUntilNext} = <strong>{formatSplitDose(item.doseMg)} mg</strong></span>
                <span class="split-hint">({item.daysUntilNext} {item.daysUntilNext === 1 ? 'day' : 'days'} until next dose)</span>
              </div>
            {/each}
          </div>
          <p class="split-total"><strong>{weeklyMg} mg</strong> total per week, before rounding.</p>
        {:else if mode === 'interval' && !validFrequency}
          <p class="split-hint">Enter days between doses greater than zero.</p>
        {:else if mode === 'interval' && dose !== null}
          <div class="calculator-math">
            <div class="calculator-math-row">
              <span class="calculator-math-label">Dose per injection</span>
              <span class="calculator-math-equals">=</span>
              <span class="calculator-math-value">
                {weeklyMg} mg ÷ 7 days × {interval} {interval === 1 ? 'day' : 'days'}
              </span>
            </div>
          </div>
          <div class="calculator-result">
            <span class="calculator-result-number">{formatSplitDose(dose)}</span>
            <span class="calculator-result-label">mg {interval === 1 ? 'every day' : `every ${interval} days`}</span>
          </div>
          <p class="split-hint">Averages {weeklyMg} mg per week over time. The amount in an individual calendar week can vary.</p>
        {:else}
          <p class="split-hint">These values are outside the calculator’s numeric range. Try less extreme values.</p>
        {/if}
      </div>

      <p class="split-note">Amounts are shown to two decimal places. This is a math conversion, not a dosing recommendation. Confirm any schedule change with your prescriber.</p>
    </div>
  </div>
</article>

<style>
  .split-description, .split-hint, .split-note, .split-total { margin: 0; }
  .split-description { color: var(--text); font-size: 0.95rem; }
  .split-hint, .split-note { color: var(--muted); font-size: 0.88rem; line-height: 1.5; }
  .split-note { border-top: 1px solid var(--cardBorder); padding-top: 0.75rem; }
  .split-controls { border: 0; padding: 0; margin: 0.5rem 0 0; min-width: 0; }
  .split-controls legend { margin-bottom: 0.4rem; }
  .split-weekdays { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .split-weekdays button { padding-inline: 0.65rem; min-width: 44px; }
  .split-dose button { min-height: 44px; }
  .split-dose button[aria-pressed='true'] { background: var(--headerBg); color: white; }
  .split-dose button:hover { border-color: var(--text); }
  .split-dose button:focus-visible, .split-dose input:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
  .split-output { display: grid; gap: 0.75rem; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .split-output .calculator-result { flex-wrap: wrap; max-width: 100%; }
  .split-output .calculator-result-number { font-size: clamp(1.8rem, 6vw, 2.6rem); }
</style>

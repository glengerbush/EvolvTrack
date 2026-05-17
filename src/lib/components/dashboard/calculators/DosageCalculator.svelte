<script lang="ts">
  import SyringeDiagram from './SyringeDiagram.svelte';
  import './calculator.css';
  import { clampSyringeUnits, getActiveVial } from './defaults';

  const defaultVial = getActiveVial();
  const defaultConcentration = defaultVial?.concentrationMg ?? 10;
  const defaultDosage = defaultVial?.prescribedDosage ?? 5;

  let concentrationMgPerMl = $state(defaultConcentration);
  let dosageMg = $state(defaultDosage);

  const mlNeeded = $derived(concentrationMgPerMl > 0 ? dosageMg / concentrationMgPerMl : 0);
  const unitsNeeded = $derived(mlNeeded * 100);
  const isValid = $derived(Number.isFinite(unitsNeeded) && unitsNeeded > 0 && concentrationMgPerMl > 0);
  const overCapacity = $derived(isValid && unitsNeeded > 100);
  const clampedUnits = $derived(clampSyringeUnits(unitsNeeded, isValid));
  const isModified = $derived(
    concentrationMgPerMl !== defaultConcentration || dosageMg !== defaultDosage
  );

  function resetToDefaults() {
    concentrationMgPerMl = defaultConcentration;
    dosageMg = defaultDosage;
  }
</script>

<article class="calculator-card">
  <h2 class="calculator-heading">How much <strong>should</strong> I take?</h2>

  <div class="calculator-body">
    <div class="calculator-inputs">
      <div class="calculator-fields">
        <label class="calculator-field">
          <span class="calculator-field-label">Vial Concentration</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={concentrationMgPerMl} min="0" step="5" />
            <span class="calculator-field-unit">mg / mL</span>
          </div>
        </label>

        <label class="calculator-field">
          <span class="calculator-field-label">Intended Dose</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={dosageMg} min="0" step="0.25" />
            <span class="calculator-field-unit">mg</span>
          </div>
        </label>

        {#if isModified}
          <button type="button" class="calculator-reset-button" onclick={resetToDefaults}>↺ Reset to defaults</button>
        {/if}
      </div>

      <div class="calculator-math">
        <div class="calculator-math-row">
          <span class="calculator-math-label">mL needed</span>
          <span class="calculator-math-equals">=</span>
          <span class="calculator-math-value">
            {dosageMg} mg ÷ {concentrationMgPerMl} mg/mL
            = <strong>{mlNeeded.toFixed(3)} mL</strong>
          </span>
        </div>
        <div class="calculator-math-row">
          <span class="calculator-math-label">Units (U-100)</span>
          <span class="calculator-math-equals">=</span>
          <span class="calculator-math-value">
            {mlNeeded.toFixed(3)} mL × 100
            = <strong>{unitsNeeded.toFixed(1)} units</strong>
          </span>
        </div>
      </div>

      <div class={['calculator-result', { over: overCapacity }]}>
        <span class="calculator-result-number">{isValid ? unitsNeeded.toFixed(1) : '—'}</span>
        <span class="calculator-result-label">units</span>
      </div>

      {#if overCapacity}
        <p class="calculator-warning">⚠ Exceeds 100-unit syringe capacity</p>
      {/if}
    </div>

    <SyringeDiagram
      units={unitsNeeded}
      valid={isValid}
      label={isValid ? `${clampedUnits.toFixed(1)} / 100 units` : 'Enter values above'}
      ariaLabel={`Syringe diagram showing ${isValid ? unitsNeeded.toFixed(1) : 0} of 100 units`}
    />
  </div>
</article>

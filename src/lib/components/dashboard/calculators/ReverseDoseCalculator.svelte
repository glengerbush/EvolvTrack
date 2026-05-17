<script lang="ts">
  import SyringeDiagram from './SyringeDiagram.svelte';
  import './calculator.css';
  import { clampSyringeUnits, getActiveVial, u100UnitsForDose } from './defaults';

  const defaultVial = getActiveVial();
  const defaultConcentration = defaultVial?.concentrationMg ?? 10;
  const defaultDoseUnits =
    defaultVial ? u100UnitsForDose(defaultVial.prescribedDosage, defaultVial.concentrationMg) : 50;

  let concentrationMgPerMl = $state(defaultConcentration);
  let doseUnits = $state(defaultDoseUnits);

  const mlDrawn = $derived(doseUnits / 100);
  const dosageMg = $derived(mlDrawn * concentrationMgPerMl);
  const isValid = $derived(
    Number.isFinite(dosageMg) && dosageMg > 0 && concentrationMgPerMl > 0 && doseUnits > 0
  );
  const overCapacity = $derived(isValid && doseUnits > 100);
  const clampedUnits = $derived(clampSyringeUnits(doseUnits, isValid));
  const isModified = $derived(
    concentrationMgPerMl !== defaultConcentration || doseUnits !== defaultDoseUnits
  );

  function resetToDefaults() {
    concentrationMgPerMl = defaultConcentration;
    doseUnits = defaultDoseUnits;
  }
</script>

<article class="calculator-card">
  <h2 class="calculator-heading">How much <strong>did</strong> I take?</h2>

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
          <span class="calculator-field-label">Units Injected</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={doseUnits} min="0" step="0.5" />
            <span class="calculator-field-unit">units</span>
          </div>
        </label>

        {#if isModified}
          <button type="button" class="calculator-reset-button" onclick={resetToDefaults}>↺ Reset to defaults</button>
        {/if}
      </div>

      <div class="calculator-math">
        <div class="calculator-math-row">
          <span class="calculator-math-label">mL injected</span>
          <span class="calculator-math-equals">=</span>
          <span class="calculator-math-value">
            {doseUnits} units ÷ 100
            = <strong>{mlDrawn.toFixed(3)} mL</strong>
          </span>
        </div>
        <div class="calculator-math-row">
          <span class="calculator-math-label">Dosage</span>
          <span class="calculator-math-equals">=</span>
          <span class="calculator-math-value">
            {mlDrawn.toFixed(3)} mL × {concentrationMgPerMl} mg/mL
            = <strong>{dosageMg.toFixed(2)} mg</strong>
          </span>
        </div>
      </div>

      <div class={['calculator-result', { over: overCapacity }]}>
        <span class="calculator-result-number">{isValid ? dosageMg.toFixed(2) : '—'}</span>
        <span class="calculator-result-label">mg</span>
      </div>

      {#if overCapacity}
        <p class="calculator-warning">⚠ Exceeds 100-unit syringe capacity</p>
      {/if}
    </div>

    <SyringeDiagram
      units={doseUnits}
      valid={isValid}
      label={isValid ? `${clampedUnits.toFixed(1)} / 100 units` : 'Enter values above'}
      ariaLabel={`Syringe diagram showing ${isValid ? doseUnits.toFixed(1) : 0} of 100 units`}
    />
  </div>
</article>

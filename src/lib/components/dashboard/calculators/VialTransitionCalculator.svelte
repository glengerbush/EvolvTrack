<script lang="ts">
  import SyringeDiagram from './SyringeDiagram.svelte';
  import './calculator.css';
  import { clampSyringeUnits, getActiveAndNextVials, u100UnitsForDose } from './defaults';

  const { currentVial, nextVial } = getActiveAndNextVials();
  const defaultFirstConcentration = currentVial?.concentrationMg ?? 10;
  const defaultNextConcentration = nextVial?.concentrationMg ?? defaultFirstConcentration;
  const defaultDesiredDosage = nextVial?.prescribedDosage ?? currentVial?.prescribedDosage ?? 5;
  const fullDoseUnitsFromFirstVial = u100UnitsForDose(defaultDesiredDosage, defaultFirstConcentration);
  const defaultFirstSyringeUnits =
    currentVial && currentVial.dosesLeft > 0 && currentVial.dosesLeft < 1
      ? Math.min(fullDoseUnitsFromFirstVial, currentVial.dosesLeft * fullDoseUnitsFromFirstVial)
      : 0;

  let firstConcentrationMgPerMl = $state(defaultFirstConcentration);
  let firstSyringeUnits = $state(defaultFirstSyringeUnits);
  let nextConcentrationMgPerMl = $state(defaultNextConcentration);
  let desiredDosageMg = $state(defaultDesiredDosage);

  const firstSyringeMl = $derived(firstSyringeUnits / 100);
  const firstSyringeMg = $derived(firstSyringeMl * firstConcentrationMgPerMl);
  const remainingMg = $derived(Math.max(0, desiredDosageMg - firstSyringeMg));
  const secondSyringeMl = $derived(
    nextConcentrationMgPerMl > 0 ? remainingMg / nextConcentrationMgPerMl : 0
  );
  const secondSyringeUnits = $derived(secondSyringeMl * 100);
  const isValid = $derived(
    Number.isFinite(secondSyringeUnits) &&
      firstSyringeUnits >= 0 &&
      firstConcentrationMgPerMl > 0 &&
      nextConcentrationMgPerMl > 0 &&
      desiredDosageMg > 0
  );
  const overCapacity = $derived(isValid && secondSyringeUnits > 100);
  const firstOverCapacity = $derived(firstSyringeUnits > 100);
  const clampedUnits = $derived(clampSyringeUnits(secondSyringeUnits, isValid));
  const isModified = $derived(
    firstConcentrationMgPerMl !== defaultFirstConcentration ||
      firstSyringeUnits !== defaultFirstSyringeUnits ||
      nextConcentrationMgPerMl !== defaultNextConcentration ||
      desiredDosageMg !== defaultDesiredDosage
  );

  function resetToDefaults() {
    firstConcentrationMgPerMl = defaultFirstConcentration;
    firstSyringeUnits = defaultFirstSyringeUnits;
    nextConcentrationMgPerMl = defaultNextConcentration;
    desiredDosageMg = defaultDesiredDosage;
  }
</script>

<article class="calculator-card">
  <h2 class="calculator-heading">Vial transition dosage</h2>

  <div class="calculator-body">
    <div class="calculator-inputs">
      <div class="calculator-fields">
        <label class="calculator-field">
          <span class="calculator-field-label">First vial concentration</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={firstConcentrationMgPerMl} min="0" step="5" />
            <span class="calculator-field-unit">mg / mL</span>
          </div>
        </label>

        <label class="calculator-field">
          <span class="calculator-field-label">First syringe</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={firstSyringeUnits} min="0" step="0.5" />
            <span class="calculator-field-unit">units</span>
          </div>
        </label>

        <label class="calculator-field">
          <span class="calculator-field-label">Next vial concentration</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={nextConcentrationMgPerMl} min="0" step="5" />
            <span class="calculator-field-unit">mg / mL</span>
          </div>
        </label>

        <label class="calculator-field">
          <span class="calculator-field-label">Total desired dosage</span>
          <div class="calculator-field-row">
            <input type="number" bind:value={desiredDosageMg} min="0" step="0.25" />
            <span class="calculator-field-unit">mg</span>
          </div>
        </label>

        {#if isModified}
          <button type="button" class="calculator-reset-button" onclick={resetToDefaults}>↺ Reset to defaults</button>
        {/if}
      </div>

      <div class="calculator-math">
        <div class="calculator-math-row">
          <span class="calculator-math-label">First syringe</span>
          <span class="calculator-math-equals">=</span>
          <span class="calculator-math-value">
            {firstSyringeUnits} units ÷ 100 × {firstConcentrationMgPerMl} mg/mL
            = <strong>{firstSyringeMg.toFixed(2)} mg</strong>
          </span>
        </div>
        <div class="calculator-math-row">
          <span class="calculator-math-label">Remaining</span>
          <span class="calculator-math-equals">=</span>
          <span class="calculator-math-value">
            {desiredDosageMg} mg - {firstSyringeMg.toFixed(2)} mg
            = <strong>{remainingMg.toFixed(2)} mg</strong>
          </span>
        </div>
        <div class="calculator-math-row">
          <span class="calculator-math-label">Second syringe</span>
          <span class="calculator-math-equals">=</span>
          <span class="calculator-math-value">
            {remainingMg.toFixed(2)} mg ÷ {nextConcentrationMgPerMl} mg/mL × 100
            = <strong>{secondSyringeUnits.toFixed(1)} units</strong>
          </span>
        </div>
      </div>

      <div class={['calculator-result', { over: overCapacity }]}>
        <span class="calculator-result-number">{isValid ? secondSyringeUnits.toFixed(1) : '—'}</span>
        <span class="calculator-result-label">units from second vial</span>
      </div>

      {#if firstOverCapacity}
        <p class="calculator-warning">⚠ First syringe exceeds 100-unit syringe capacity</p>
      {/if}
      {#if overCapacity}
        <p class="calculator-warning">⚠ Second syringe exceeds 100-unit syringe capacity</p>
      {/if}
    </div>

    <SyringeDiagram
      units={secondSyringeUnits}
      valid={isValid}
      label={isValid ? `${clampedUnits.toFixed(1)} / 100 units` : 'Enter values above'}
      ariaLabel={`Syringe diagram showing ${isValid ? secondSyringeUnits.toFixed(1) : 0} of 100 units from the second vial`}
    />
  </div>
</article>

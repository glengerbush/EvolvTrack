import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { getAllInjections, getAllWeights } from '$lib/domain/repo';
import { saveInputRows, type HealthInputRowSaveInput } from '$lib/domain/healthInputs';

const SEMA = 'Semaglutide (Ozempic / Wegovy)' as const;
const TODAY = iso('2026-05-10');
const FUTURE = iso('2026-05-20');

function input(overrides: Partial<HealthInputRowSaveInput>): HealthInputRowSaveInput {
  return {
    date: TODAY,
    symptoms: [],
    ...overrides,
  };
}

describe('saveInputRows — weight-only rows', () => {
  it('inserts a new weight when one is provided without an injection', async () => {
    const [saved] = await saveInputRows(
      [input({ weightLbs: 180, wellness: 5 })],
      { today: TODAY },
    );
    expect(saved.injectionSaved).toBe(false);
    expect(saved.weightId).toBeTruthy();

    const weights = await getAllWeights();
    expect(weights).toHaveLength(1);
    expect(weights[0]).toMatchObject({ date: TODAY, weightLbs: 180, wellness: 5 });
  });

  it('does not touch the weights table for a row with no weight-ish data', async () => {
    await saveInputRows([input({})], { today: TODAY });
    expect(await getAllWeights()).toHaveLength(0);
  });
});

describe('saveInputRows — planned vs confirmed semantics', () => {
  it("auto-flags a future-dated dose as planned without an explicit dosePlanned", async () => {
    const [saved] = await saveInputRows(
      [input({ date: FUTURE, doseMg: 5, medication: SEMA })],
      { today: TODAY },
    );

    expect(saved.dosePlanned).toBe(true);
    expect(saved.doseSkipped).toBe(false);
    expect(saved.doseConfirmedAt).toBeUndefined();

    const injections = await getAllInjections();
    expect(injections).toHaveLength(1);
    expect(injections[0]).toMatchObject({
      amountMg: 5,
      medication: SEMA,
      planned: true,
      skipped: false,
    });
  });

  it('does not flag a same-day-or-past dose as planned by default', async () => {
    const [saved] = await saveInputRows(
      [input({ date: TODAY, doseMg: 5, medication: SEMA })],
      { today: TODAY },
    );
    expect(saved.dosePlanned).toBe(false);
  });

  it('explicit dosePlanned: false + doseConfirmedAt overrides the auto-plan rule even for future dates', async () => {
    const confirmedAt = '2026-05-20T12:00:00.000Z';
    const [saved] = await saveInputRows(
      [
        input({
          date: FUTURE,
          doseMg: 5,
          medication: SEMA,
          dosePlanned: false,
          doseConfirmedAt: confirmedAt,
        }),
      ],
      { today: TODAY },
    );

    expect(saved.dosePlanned).toBe(false);
    expect(saved.doseConfirmedAt).toBe(confirmedAt);

    const [inj] = await getAllInjections();
    expect(inj.planned).toBe(false);
    expect(inj.confirmedAt).toBe(confirmedAt);
  });
});

describe('saveInputRows — skip semantics', () => {
  it('skipped doses are written with planned=false and confirmedAt=undefined', async () => {
    const [saved] = await saveInputRows(
      [
        input({
          date: TODAY,
          doseMg: 5,
          medication: SEMA,
          doseSkipped: true,
          dosePlanned: true, // even if true, skip wins
          doseConfirmedAt: '2026-05-10T00:00:00.000Z',
        }),
      ],
      { today: TODAY },
    );

    expect(saved.doseSkipped).toBe(true);
    expect(saved.dosePlanned).toBe(false);
    expect(saved.doseConfirmedAt).toBeUndefined();

    const [inj] = await getAllInjections();
    expect(inj.skipped).toBe(true);
    expect(inj.planned).toBe(false);
    expect(inj.confirmedAt).toBeUndefined();
  });
});

describe('saveInputRows — defaults and identity', () => {
  it('falls back to options.defaultMedication when the row has no medication', async () => {
    const [saved] = await saveInputRows(
      [input({ doseMg: 5 })],
      { today: TODAY, defaultMedication: SEMA },
    );
    expect(saved.medication).toBe(SEMA);

    const [inj] = await getAllInjections();
    expect(inj.medication).toBe(SEMA);
  });

  it('returns no injection identifier when doseMg is missing or non-finite', async () => {
    const [saved] = await saveInputRows(
      [input({ doseMg: Number.NaN, medication: SEMA, weightLbs: 180 })],
      { today: TODAY },
    );
    expect(saved.injectionSaved).toBe(false);
    expect(saved.injectionId).toBeUndefined();
    expect(saved.weightId).toBeTruthy();

    expect(await getAllInjections()).toHaveLength(0);
    expect(await getAllWeights()).toHaveLength(1);
  });

  it('updating an existing injection preserves the same id', async () => {
    const [first] = await saveInputRows(
      [input({ date: TODAY, doseMg: 5, medication: SEMA })],
      { today: TODAY },
    );
    expect(first.injectionId).toBeTruthy();

    const [second] = await saveInputRows(
      [
        {
          ...input({ date: TODAY, doseMg: 7, medication: SEMA }),
          injectionId: first.injectionId,
        },
      ],
      { today: TODAY },
    );
    expect(second.injectionId).toBe(first.injectionId);

    const injections = await getAllInjections();
    expect(injections).toHaveLength(1);
    expect(injections[0].amountMg).toBe(7);
  });
});

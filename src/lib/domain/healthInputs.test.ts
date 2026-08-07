import { describe, expect, it } from 'vitest';
import '../../test/dexie-setup';
import { iso } from '../../test/iso';
import { getAllEntries } from '$lib/domain/health-data-storage';
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

describe('saveInputRows — weigh-in-only rows', () => {
  it('inserts a single entry for a weigh-in with no dose', async () => {
    const [saved] = await saveInputRows(
      [input({ weightLbs: 180, wellness: 5 })],
      { today: TODAY },
    );
    expect(saved.entryId).toBeTruthy();

    const entries = await getAllEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ date: TODAY, weightLbs: 180, wellness: 5 });
    expect(entries[0].amountMg).toBeUndefined();
  });

  it('still writes an entry for a row with no weight-ish data (each row is its own record)', async () => {
    await saveInputRows([input({})], { today: TODAY });
    expect(await getAllEntries()).toHaveLength(1);
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

    const entries = await getAllEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
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

    const [entry] = await getAllEntries();
    expect(entry.planned).toBe(false);
    expect(entry.confirmedAt).toBe(confirmedAt);
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

    const [entry] = await getAllEntries();
    expect(entry.skipped).toBe(true);
    expect(entry.planned).toBe(false);
    expect(entry.confirmedAt).toBeUndefined();
  });
});

describe('saveInputRows — defaults and identity', () => {
  it('falls back to options.defaultMedication when the row has no medication', async () => {
    const [saved] = await saveInputRows(
      [input({ doseMg: 5 })],
      { today: TODAY, defaultMedication: SEMA },
    );
    expect(saved.medication).toBe(SEMA);

    const [entry] = await getAllEntries();
    expect(entry.medication).toBe(SEMA);
  });

  it('saves a weigh-in entry (no dose) when doseMg is missing or non-finite', async () => {
    const [saved] = await saveInputRows(
      [input({ doseMg: Number.NaN, medication: SEMA, weightLbs: 180 })],
      { today: TODAY },
    );
    expect(saved.entryId).toBeTruthy();

    const entries = await getAllEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].amountMg).toBeUndefined();
    expect(entries[0].weightLbs).toBe(180);
  });

  it('updating an existing entry preserves the same id', async () => {
    const [first] = await saveInputRows(
      [input({ date: TODAY, doseMg: 5, medication: SEMA })],
      { today: TODAY },
    );
    expect(first.entryId).toBeTruthy();

    const [second] = await saveInputRows(
      [
        {
          ...input({ date: TODAY, doseMg: 7, medication: SEMA }),
          entryId: first.entryId,
        },
      ],
      { today: TODAY },
    );
    expect(second.entryId).toBe(first.entryId);

    const entries = await getAllEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].amountMg).toBe(7);
  });
});

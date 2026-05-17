import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { dismissedReminders } from '$lib/stores/dismissedRemindersStore';

// Store is a module singleton; reset before each test for isolation.
beforeEach(() => dismissedReminders.restoreAll());

describe('dismissedReminders — dismissBud', () => {
  it('records the BUD snapshot at dismissal time', () => {
    dismissedReminders.dismissBud('rx-1', '2026-06-01');
    const state = get(dismissedReminders);
    expect(state.bud['rx-1']).toMatchObject({ bud: '2026-06-01' });
    expect(state.bud['rx-1'].dismissedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('overwrites an earlier dismissal for the same prescription when re-dismissed', () => {
    dismissedReminders.dismissBud('rx-1', '2026-06-01');
    dismissedReminders.dismissBud('rx-1', '2026-06-15');
    expect(get(dismissedReminders).bud['rx-1'].bud).toBe('2026-06-15');
  });
});

describe('dismissedReminders — dismissRefill', () => {
  it('records the dose count at dismissal time', () => {
    dismissedReminders.dismissRefill('Semaglutide', 3);
    expect(get(dismissedReminders).refill['Semaglutide']).toMatchObject({ atDoses: 3 });
  });
});

describe('dismissedReminders — reconcile', () => {
  it('drops BUD dismissals whose prescription is no longer known', () => {
    dismissedReminders.dismissBud('rx-still-here', '2026-06-01');
    dismissedReminders.dismissBud('rx-deleted', '2026-06-01');

    dismissedReminders.reconcile({
      knownPrescriptionIds: new Set(['rx-still-here']),
      refillSupplyByType: new Map(),
      refillThreshold: 4,
    });

    const state = get(dismissedReminders);
    expect(state.bud).toHaveProperty('rx-still-here');
    expect(state.bud).not.toHaveProperty('rx-deleted');
  });

  it('keeps refill dismissals while supply is below threshold', () => {
    dismissedReminders.dismissRefill('Semaglutide', 3);
    dismissedReminders.reconcile({
      knownPrescriptionIds: new Set(),
      refillSupplyByType: new Map([['Semaglutide', 2]]),
      refillThreshold: 4,
    });
    expect(get(dismissedReminders).refill).toHaveProperty('Semaglutide');
  });

  it('drops a refill dismissal when supply recovers above threshold so it can re-fire later', () => {
    dismissedReminders.dismissRefill('Semaglutide', 3);
    dismissedReminders.reconcile({
      knownPrescriptionIds: new Set(),
      refillSupplyByType: new Map([['Semaglutide', 10]]),
      refillThreshold: 4,
    });
    expect(get(dismissedReminders).refill).not.toHaveProperty('Semaglutide');
  });

  it('drops a refill dismissal when the drug type no longer appears in supply at all', () => {
    dismissedReminders.dismissRefill('Tirzepatide', 1);
    dismissedReminders.reconcile({
      knownPrescriptionIds: new Set(),
      refillSupplyByType: new Map(),
      refillThreshold: 4,
    });
    expect(get(dismissedReminders).refill).not.toHaveProperty('Tirzepatide');
  });

  it('keeps the reference stable when nothing changes (avoid spurious subscriber wakeups)', () => {
    dismissedReminders.dismissBud('rx-1', '2026-06-01');
    const before = get(dismissedReminders);
    dismissedReminders.reconcile({
      knownPrescriptionIds: new Set(['rx-1']),
      refillSupplyByType: new Map(),
      refillThreshold: 4,
    });
    expect(get(dismissedReminders)).toBe(before);
  });
});

describe('dismissedReminders — restoreAll', () => {
  it('empties both maps', () => {
    dismissedReminders.dismissBud('rx-1', '2026-06-01');
    dismissedReminders.dismissRefill('Semaglutide', 3);
    dismissedReminders.restoreAll();
    const state = get(dismissedReminders);
    expect(state.bud).toEqual({});
    expect(state.refill).toEqual({});
  });
});

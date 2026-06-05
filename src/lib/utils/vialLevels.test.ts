import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import {
  computeVialLevels,
  manualMgUsedForDesiredLeft,
  type DoseEvent,
  type VialSpec,
} from './vialLevels';

const SEMA = 'Semaglutide (Ozempic / Wegovy)';
const TIRZ = 'Tirzepatide (Mounjaro / Zepbound)';

type VialInput = Omit<Partial<VialSpec>, 'compoundDate'> & { id: string; compoundDate?: string };

function vial(over: VialInput): VialSpec {
  const { compoundDate, ...rest } = over;
  return {
    medication: SEMA,
    concentrationMgMl: 5,
    vialMl: 2,
    prescribedDoseMg: 2.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...rest,
    ...(compoundDate ? { compoundDate: iso(compoundDate) } : {}),
  };
}

function dose(over: { date: string; amountMg: number; medication?: string; createdAt?: string }): DoseEvent {
  return {
    medication: over.medication ?? SEMA,
    date: iso(over.date),
    amountMg: over.amountMg,
    createdAt: over.createdAt,
  };
}

describe('computeVialLevels', () => {
  it('capacity = concentration × mL, and depletes by dose mg', () => {
    const levels = computeVialLevels(
      [vial({ id: 'v1' })], // 5 × 2 = 10 mg, dose 2.5 ⇒ 4 doses
      [dose({ date: '2026-05-01', amountMg: 2.5 })],
    );
    const v = levels.get('v1')!;
    expect(v.mgCapacity).toBe(10);
    expect(v.mgUsed).toBe(2.5);
    expect(v.mgLeft).toBe(7.5);
    expect(v.dosesLeft).toBe(3);
    expect(v.over).toBe(false);
  });

  it('splits a dose across vials when the current one runs out (top of table first)', () => {
    const levels = computeVialLevels(
      [
        vial({ id: 'top', sortOrder: 0 }), // 10 mg — highest on the table
        vial({ id: 'next', sortOrder: 1 }), // 10 mg
      ],
      [
        dose({ date: '2026-05-02', amountMg: 8 }), // drains top to 2
        dose({ date: '2026-05-09', amountMg: 5 }), // 2 from top (→0), 3 from next
      ],
    );
    expect(levels.get('top')!.mgLeft).toBe(0);
    expect(levels.get('next')!.mgLeft).toBe(7); // 10 − 3
    expect(levels.get('top')!.over).toBe(false);
  });

  it('attributes by table order, not by compound date', () => {
    // The vial higher on the table (lower sortOrder) drains first even when it
    // has the *newer* compound date — date must not drive attribution anymore.
    const levels = computeVialLevels(
      [
        vial({ id: 'top', sortOrder: 0, compoundDate: iso('2026-05-01') }), // newer
        vial({ id: 'bottom', sortOrder: 1, compoundDate: iso('2026-04-01') }), // older
      ],
      [dose({ date: '2026-05-05', amountMg: 12 })], // 10 from top (→0), 2 from bottom
    );
    expect(levels.get('top')!.mgLeft).toBe(0);
    expect(levels.get('bottom')!.mgLeft).toBe(8); // 10 − 2
  });

  it('flags overfill: consumption past the labeled fill goes negative on the last vial', () => {
    const levels = computeVialLevels(
      [vial({ id: 'v1' })], // 10 mg
      [
        dose({ date: '2026-05-01', amountMg: 2.5 }),
        dose({ date: '2026-05-08', amountMg: 2.5 }),
        dose({ date: '2026-05-15', amountMg: 2.5 }),
        dose({ date: '2026-05-22', amountMg: 2.5 }),
        dose({ date: '2026-05-29', amountMg: 2.5 }), // 5th dose — past the 4 the label holds
      ],
    );
    const v = levels.get('v1')!;
    expect(v.mgUsed).toBe(12.5);
    expect(v.mgLeft).toBe(-2.5);
    expect(v.mgLeftClamped).toBe(0);
    expect(v.dosesLeft).toBe(0);
    expect(v.over).toBe(true);
  });

  it('keeps medications separate', () => {
    const levels = computeVialLevels(
      [
        vial({ id: 's', medication: SEMA }),
        vial({ id: 't', medication: TIRZ, concentrationMgMl: 20, vialMl: 1, prescribedDoseMg: 5 }), // 20 mg
      ],
      [
        dose({ date: '2026-05-01', amountMg: 2.5, medication: SEMA }),
        dose({ date: '2026-05-01', amountMg: 5, medication: TIRZ }),
      ],
    );
    expect(levels.get('s')!.mgLeft).toBe(7.5);
    expect(levels.get('t')!.mgLeft).toBe(15);
  });

  it('applies manualMgUsed as an additive correction without changing FIFO room', () => {
    const levels = computeVialLevels(
      [vial({ id: 'v1', manualMgUsed: 2.5 })], // pretend 1 dose taken pre-logging
      [dose({ date: '2026-05-01', amountMg: 2.5 })],
    );
    const v = levels.get('v1')!;
    expect(v.mgUsedFromDoses).toBe(2.5);
    expect(v.mgUsed).toBe(5);
    expect(v.mgLeft).toBe(5);
    expect(v.dosesLeft).toBe(2);
  });

  it('returns a null level for a vial with incomplete specs', () => {
    const levels = computeVialLevels([vial({ id: 'v1', vialMl: 0 })], []);
    const v = levels.get('v1')!;
    expect(v.mgCapacity).toBeNull();
    expect(v.mgLeft).toBeNull();
    expect(v.dosesLeft).toBeNull();
  });

  it('reports null dosesLeft when no prescribed dose size is set', () => {
    const levels = computeVialLevels([vial({ id: 'v1', prescribedDoseMg: 0 })], []);
    expect(levels.get('v1')!.mgLeft).toBe(10);
    expect(levels.get('v1')!.dosesLeft).toBeNull();
  });
});

describe('manualMgUsedForDesiredLeft', () => {
  it('back-solves the correction so remaining equals what the user typed', () => {
    // capacity 10, 2.5 already poured by doses, user wants 5 mg left.
    const offset = manualMgUsedForDesiredLeft(10, 2.5, 5);
    expect(offset).toBe(2.5);
    const levels = computeVialLevels(
      [
        {
          id: 'v1',
          medication: SEMA,
          concentrationMgMl: 5,
          vialMl: 2,
          prescribedDoseMg: 2.5,
          createdAt: 'c',
          manualMgUsed: offset,
        },
      ],
      [dose({ date: '2026-05-01', amountMg: 2.5 })],
    );
    expect(levels.get('v1')!.mgLeft).toBe(5);
  });
});

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

  it('splits a dose across vials when the current one runs out (FIFO by compound date)', () => {
    const levels = computeVialLevels(
      [
        vial({ id: 'old', compoundDate: iso('2026-04-01') }), // 10 mg
        vial({ id: 'new', compoundDate: iso('2026-05-01') }), // 10 mg
      ],
      [
        dose({ date: '2026-05-02', amountMg: 8 }), // drains old to 2
        dose({ date: '2026-05-09', amountMg: 5 }), // 2 from old (→0), 3 from new
      ],
    );
    expect(levels.get('old')!.mgLeft).toBe(0);
    expect(levels.get('new')!.mgLeft).toBe(7); // 10 − 3
    expect(levels.get('old')!.over).toBe(false);
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

import { describe, expect, it } from 'vitest';
import { iso } from '../../test/iso';
import {
  attributeVials,
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

function dose(over: { id?: string; date: string; amountMg: number; medication?: string; createdAt?: string; prescriptionId?: string }): DoseEvent {
  return {
    id: over.id,
    medication: over.medication ?? SEMA,
    date: iso(over.date),
    amountMg: over.amountMg,
    createdAt: over.createdAt,
    prescriptionId: over.prescriptionId,
  };
}

describe('computeVialLevels', () => {
  it('capacity = concentration × mL, and depletes by an attributed dose', () => {
    const levels = computeVialLevels(
      [vial({ id: 'v1' })], // 5 × 2 = 10 mg, dose 2.5 ⇒ 4 doses
      [dose({ date: '2026-05-01', amountMg: 2.5, prescriptionId: 'v1' })],
    );
    const v = levels.get('v1')!;
    expect(v.mgCapacity).toBe(10);
    expect(v.mgUsed).toBe(2.5);
    expect(v.mgLeft).toBe(7.5);
    expect(v.dosesLeft).toBe(3);
    expect(v.over).toBe(false);
  });

  it('drains nothing for a dose with no vial attribution', () => {
    // No FIFO / auto-guessing: an unattributed dose is "unassigned" and consumes
    // no vial until the user picks one.
    const levels = computeVialLevels(
      [vial({ id: 'v1' })],
      [dose({ date: '2026-05-01', amountMg: 2.5 })],
    );
    expect(levels.get('v1')!.mgUsed).toBe(0);
    expect(levels.get('v1')!.mgLeft).toBe(10);
  });

  it('drains only the attributed vial, never a different one', () => {
    const levels = computeVialLevels(
      [
        vial({ id: 'top', sortOrder: 0 }), // 10 mg
        vial({ id: 'next', sortOrder: 1 }), // 10 mg
      ],
      [
        dose({ date: '2026-05-02', amountMg: 8, prescriptionId: 'top' }),
        dose({ date: '2026-05-09', amountMg: 5, prescriptionId: 'next' }),
      ],
    );
    expect(levels.get('top')!.mgLeft).toBe(2); // 10 − 8
    expect(levels.get('next')!.mgLeft).toBe(5); // 10 − 5
  });

  it('flags overfill: consumption past the labeled fill goes negative', () => {
    const levels = computeVialLevels(
      [vial({ id: 'v1' })], // 10 mg
      [
        dose({ date: '2026-05-01', amountMg: 2.5, prescriptionId: 'v1' }),
        dose({ date: '2026-05-08', amountMg: 2.5, prescriptionId: 'v1' }),
        dose({ date: '2026-05-15', amountMg: 2.5, prescriptionId: 'v1' }),
        dose({ date: '2026-05-22', amountMg: 2.5, prescriptionId: 'v1' }),
        dose({ date: '2026-05-29', amountMg: 2.5, prescriptionId: 'v1' }), // 5th — past the 4 the label holds
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
        dose({ date: '2026-05-01', amountMg: 2.5, medication: SEMA, prescriptionId: 's' }),
        dose({ date: '2026-05-01', amountMg: 5, medication: TIRZ, prescriptionId: 't' }),
      ],
    );
    expect(levels.get('s')!.mgLeft).toBe(7.5);
    expect(levels.get('t')!.mgLeft).toBe(15);
  });

  it('applies manualMgUsed as an additive correction on top of attributed doses', () => {
    const levels = computeVialLevels(
      [vial({ id: 'v1', manualMgUsed: 2.5 })], // pretend 1 dose taken pre-logging
      [dose({ date: '2026-05-01', amountMg: 2.5, prescriptionId: 'v1' })],
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

  it('drains exactly the attributed vial regardless of table order', () => {
    const levels = computeVialLevels(
      [
        vial({ id: 'top', sortOrder: 0 }), // 10 mg
        vial({ id: 'next', sortOrder: 1 }), // 10 mg
      ],
      [dose({ date: '2026-05-02', amountMg: 4, prescriptionId: 'next' })],
    );
    expect(levels.get('top')!.mgUsed).toBe(0);
    expect(levels.get('top')!.mgLeft).toBe(10);
    expect(levels.get('next')!.mgUsed).toBe(4);
    expect(levels.get('next')!.mgLeft).toBe(6);
  });

  it('an attribution can push its vial into overfill (honest negative)', () => {
    const levels = computeVialLevels(
      [vial({ id: 'v1' })], // 10 mg capacity
      [dose({ date: '2026-05-01', amountMg: 13, prescriptionId: 'v1' })],
    );
    const v = levels.get('v1')!;
    expect(v.mgUsed).toBe(13);
    expect(v.mgLeft).toBe(-3);
    expect(v.over).toBe(true);
  });

  it('drains nothing when a dose is attributed to a vial of another medication', () => {
    const levels = computeVialLevels(
      [
        vial({ id: 'sema', medication: SEMA, sortOrder: 0 }),
        vial({ id: 'tirz', medication: TIRZ, sortOrder: 0 }),
      ],
      // A SEMA dose attributed to a TIRZ vial is invalid → it consumes nothing
      // (no silent reassignment to another vial).
      [dose({ date: '2026-05-01', amountMg: 2.5, medication: SEMA, prescriptionId: 'tirz' })],
    );
    expect(levels.get('sema')!.mgUsed).toBe(0);
    expect(levels.get('tirz')!.mgUsed).toBe(0);
  });
});

describe('attributeVials — auto-pick (which vial a dose draws from)', () => {
  const top = () => vial({ id: 'top', sortOrder: 0 }); // 10 mg, highest on table
  const next = () => vial({ id: 'next', sortOrder: 1 }); // 10 mg

  it('passes a stored attribution through unchanged (auto: false)', () => {
    const attr = attributeVials(
      [top(), next()],
      [dose({ id: 'd1', date: '2026-05-01', amountMg: 4, prescriptionId: 'next' })],
    );
    expect(attr.get('d1')).toEqual({ vialId: 'next', auto: false });
  });

  it('fills by table order, one vial at a time, then moves down when full', () => {
    const attr = attributeVials(
      [top(), next()],
      [
        dose({ id: 'a', date: '2026-05-01', amountMg: 6 }), // top (room 10)
        dose({ id: 'b', date: '2026-05-02', amountMg: 4 }), // top (room 4 left)
        dose({ id: 'c', date: '2026-05-03', amountMg: 3 }), // top now full → next
      ],
    );
    expect(attr.get('a')).toEqual({ vialId: 'top', auto: true });
    expect(attr.get('b')).toEqual({ vialId: 'top', auto: true });
    expect(attr.get('c')).toEqual({ vialId: 'next', auto: true });
  });

  it('assigns the latest dose to the current vial (first with room)', () => {
    // `top` already drained by a stored dose; a new latest dose goes to `next`.
    const attr = attributeVials(
      [top(), next()],
      [
        dose({ id: 'frozen', date: '2026-05-10', amountMg: 10, prescriptionId: 'top' }), // top full
        dose({ id: 'today', date: '2026-05-25', amountMg: 2.5 }), // latest, auto
      ],
    );
    expect(attr.get('today')).toEqual({ vialId: 'next', auto: true });
  });

  it('auto-assigns a past dose to the next dose’s vial when that vial has room', () => {
    const attr = attributeVials(
      [top(), next()],
      [
        dose({ id: 'f1', date: '2026-05-10', amountMg: 10, prescriptionId: 'top' }), // top full
        dose({ id: 'f2', date: '2026-05-20', amountMg: 3, prescriptionId: 'next' }), // next has room
        // Inserted between f1 and f2 → next attributed dose is f2 (next, room) → next.
        dose({ id: 'past', date: '2026-05-15', amountMg: 2.5 }),
      ],
    );
    expect(attr.get('past')).toEqual({ vialId: 'next', auto: true });
  });

  it('leaves a past dose UNASSIGNED when the temporally-next vial is already full', () => {
    const attr = attributeVials(
      [top(), next()],
      [
        dose({ id: 'f1', date: '2026-05-10', amountMg: 10, prescriptionId: 'top' }), // top full
        dose({ id: 'f2', date: '2026-05-20', amountMg: 3, prescriptionId: 'next' }),
        // Inserted before f1 → next attributed dose is f1 (top), but top is full → blank.
        dose({ id: 'past', date: '2026-05-05', amountMg: 2.5 }),
      ],
    );
    expect(attr.has('past')).toBe(false);
  });

  it('leaves a dose unassigned when its medication has no usable vials', () => {
    const attr = attributeVials(
      [top()], // only SEMA vials
      [dose({ id: 'd', date: '2026-05-01', amountMg: 5, medication: TIRZ })],
    );
    expect(attr.has('d')).toBe(false);
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
      [dose({ date: '2026-05-01', amountMg: 2.5, prescriptionId: 'v1' })],
    );
    expect(levels.get('v1')!.mgLeft).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';
import { clampCol, clampMove, clampRow, nextSelectable } from './gridNav';

describe('clampRow / clampCol', () => {
  it('clamps into range', () => {
    expect(clampRow(-3, 5)).toBe(0);
    expect(clampRow(9, 5)).toBe(4);
    expect(clampRow(2, 5)).toBe(2);
  });
  it('clamps to 0 when empty', () => {
    expect(clampRow(3, 0)).toBe(0);
    expect(clampCol(3, 0)).toBe(0);
  });
});

describe('clampMove', () => {
  const dims = { rowCount: 4, colCount: 3 };
  it('moves and clamps within the grid', () => {
    expect(clampMove({ row: 1, col: 1 }, 1, 0, dims)).toEqual({ row: 2, col: 1 });
    expect(clampMove({ row: 1, col: 1 }, 0, 1, dims)).toEqual({ row: 1, col: 2 });
  });
  it('clamps at the edges', () => {
    expect(clampMove({ row: 0, col: 0 }, -1, -1, dims)).toEqual({ row: 0, col: 0 });
    expect(clampMove({ row: 3, col: 2 }, 1, 1, dims)).toEqual({ row: 3, col: 2 });
  });
});

describe('nextSelectable', () => {
  // selectable rows: 0 and 3 (1, 2 are computed/non-navigable).
  const selectable = (i: number) => i === 0 || i === 3;
  it('skips non-selectable indices going down', () => {
    expect(nextSelectable(0, 1, 4, selectable)).toBe(3);
  });
  it('skips non-selectable indices going up', () => {
    expect(nextSelectable(3, -1, 4, selectable)).toBe(0);
  });
  it('stays put when there is no further selectable index', () => {
    expect(nextSelectable(3, 1, 4, selectable)).toBe(3);
    expect(nextSelectable(0, -1, 4, selectable)).toBe(0);
  });
});

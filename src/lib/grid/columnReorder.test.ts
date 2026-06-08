import { describe, expect, it } from 'vitest';
import {
  colIndicator,
  mergeColumnOrder,
  moveItem,
  reorderVisible,
  sanitizeHidden,
} from './columnReorder';

describe('moveItem', () => {
  it('moves an item forward', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('moves an item backward', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });
  it('is a no-op for equal or out-of-range indices, returning a copy', () => {
    const src = ['a', 'b'];
    expect(moveItem(src, 1, 1)).toEqual(['a', 'b']);
    expect(moveItem(src, 5, 0)).toEqual(['a', 'b']);
    expect(moveItem(src, 0, 0)).not.toBe(src); // fresh array
  });
});

describe('reorderVisible', () => {
  const hidden = (set: string[]) => (k: string) => set.includes(k);

  it('reorders by visible index, ignoring hidden keys', () => {
    // visible = [a, c, d] (b hidden); move visible#0 (a) → visible#2.
    const out = reorderVisible(['a', 'b', 'c', 'd'], hidden(['b']), 0, 2);
    // b keeps its slot; visible order becomes c, d, a.
    expect(out).toEqual(['c', 'b', 'd', 'a']);
  });

  it('keeps hidden keys pinned to their positions', () => {
    // visible = [a, c]; b hidden in the middle. Move a→after c.
    const out = reorderVisible(['a', 'b', 'c'], hidden(['b']), 0, 1);
    expect(out).toEqual(['c', 'b', 'a']);
  });

  it('no-ops on equal indices', () => {
    expect(reorderVisible(['a', 'b', 'c'], hidden([]), 1, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('colIndicator', () => {
  it('returns null with no active drag', () => {
    expect(colIndicator(null, 2, 5)).toBeNull();
    expect(colIndicator(2, null, 5)).toBeNull();
    expect(colIndicator(2, 2, 5)).toBeNull();
  });
  it('marks the left edge of the drop target when dragging left', () => {
    expect(colIndicator(3, 1, 5)).toEqual({ col: 1, side: 'left' });
  });
  it('marks the left edge of the next column when dragging right (mid-table)', () => {
    expect(colIndicator(1, 3, 5)).toEqual({ col: 4, side: 'left' });
  });
  it('marks the right edge of the last column when dragging to the end', () => {
    expect(colIndicator(1, 4, 5)).toEqual({ col: 4, side: 'right' });
  });
});

describe('mergeColumnOrder', () => {
  const DEFAULT = ['day', 'date', 'weight', 'dose', 'notes'] as const;

  it('returns the default order when nothing is saved', () => {
    expect(mergeColumnOrder(undefined, DEFAULT)).toEqual([...DEFAULT]);
  });
  it('keeps the saved order for known keys', () => {
    expect(mergeColumnOrder(['notes', 'dose', 'weight', 'date', 'day'], DEFAULT)).toEqual([
      'notes',
      'dose',
      'weight',
      'date',
      'day',
    ]);
  });
  it('drops unknown saved keys but still includes every default key', () => {
    const out = mergeColumnOrder(['dose', 'bogus', 'day'], DEFAULT);
    expect(out).not.toContain('bogus');
    expect([...out].sort()).toEqual([...DEFAULT].sort()); // all defaults present
    expect(out.indexOf('dose')).toBeLessThan(out.indexOf('day')); // saved relative order kept
  });
  it('splices a new default key next to its default neighbour', () => {
    // Saved settings predate "weight"; it should land after "date" (its default predecessor).
    expect(mergeColumnOrder(['day', 'date', 'dose', 'notes'], DEFAULT)).toEqual([
      'day',
      'date',
      'weight',
      'dose',
      'notes',
    ]);
  });
  it('unshifts a new leading key when its predecessors are all absent', () => {
    expect(mergeColumnOrder(['weight', 'dose'], DEFAULT)).toEqual(['day', 'date', 'weight', 'dose', 'notes']);
  });
});

describe('sanitizeHidden', () => {
  const DEFAULT = ['day', 'date', 'weight'] as const;
  it('keeps only valid keys', () => {
    expect(sanitizeHidden(['weight', 'bogus', 'date'], DEFAULT)).toEqual(['weight', 'date']);
  });
  it('returns [] for undefined', () => {
    expect(sanitizeHidden(undefined, DEFAULT)).toEqual([]);
  });
});

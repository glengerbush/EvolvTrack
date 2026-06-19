import { describe, it, expect } from 'vitest';
import { computeMenuPlacement, type AnchorRect } from './floatingMenu';

const viewport = { viewportWidth: 1000, viewportHeight: 800 };

// A trigger near the top of the viewport with room below.
const topAnchor: AnchorRect = { left: 100, top: 50, bottom: 70, width: 160 };

describe('computeMenuPlacement', () => {
  it('drops the menu below the anchor when it fits', () => {
    const p = computeMenuPlacement({
      anchor: topAnchor,
      menuHeight: 200,
      menuWidth: 160,
      ...viewport,
      gap: 4,
    });
    expect(p.flipUp).toBe(false);
    expect(p.top).toBe(topAnchor.bottom + 4);
    expect(p.left).toBe(topAnchor.left);
  });

  it('flips above when the menu does not fit below and there is more room above', () => {
    // Anchor near the bottom: little space below, lots above.
    const bottomAnchor: AnchorRect = { left: 100, top: 700, bottom: 720, width: 160 };
    const menuHeight = 200;
    const p = computeMenuPlacement({
      anchor: bottomAnchor,
      menuHeight,
      menuWidth: 160,
      ...viewport,
      gap: 4,
    });
    expect(p.flipUp).toBe(true);
    expect(p.top).toBe(bottomAnchor.top - 4 - menuHeight);
  });

  it('stays below when it does not fit, but space below still exceeds space above', () => {
    // Anchor near the top: tall menu overflows below, yet below > above, so a
    // flip would be worse — keep it below.
    const p = computeMenuPlacement({
      anchor: topAnchor,
      menuHeight: 900, // taller than the whole viewport
      menuWidth: 160,
      ...viewport,
      gap: 4,
    });
    expect(p.flipUp).toBe(false);
    expect(p.top).toBe(topAnchor.bottom + 4);
  });

  it('never positions a flipped menu above the top margin', () => {
    // Anchor with slightly more room above than below, but not enough for the
    // whole menu — top is clamped to the margin rather than going negative.
    const anchor: AnchorRect = { left: 100, top: 500, bottom: 520, width: 160 };
    const p = computeMenuPlacement({
      anchor,
      menuHeight: 600,
      menuWidth: 160,
      ...viewport,
      gap: 4,
      margin: 8,
    });
    expect(p.flipUp).toBe(true);
    expect(p.top).toBe(8);
  });

  it('clamps the menu to the right viewport edge', () => {
    const anchor: AnchorRect = { left: 950, top: 50, bottom: 70, width: 40 };
    const p = computeMenuPlacement({
      anchor,
      menuHeight: 100,
      menuWidth: 300,
      ...viewport,
      margin: 8,
    });
    // maxLeft = 1000 - 300 - 8 = 692
    expect(p.left).toBe(692);
  });

  it('clamps a partly off-screen (negative left) anchor to the left margin', () => {
    const anchor: AnchorRect = { left: -20, top: 50, bottom: 70, width: 160 };
    const p = computeMenuPlacement({
      anchor,
      menuHeight: 100,
      menuWidth: 160,
      ...viewport,
      margin: 8,
    });
    expect(p.left).toBe(8);
  });
});

import type { Action } from 'svelte/action';

/** Minimal rect shape — just the fields placement needs, so the pure function
 *  is trivially testable without a real DOMRect. */
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface PlacementInput {
  anchor: AnchorRect;
  menuHeight: number;
  menuWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Vertical gap between anchor and menu, px. */
  gap?: number;
  /** Keep-out margin from the viewport edges, px. */
  margin?: number;
}

export interface Placement {
  left: number;
  top: number;
  flipUp: boolean;
}

/**
 * Decide where a dropdown menu should sit relative to its trigger, in viewport
 * (fixed-position) coordinates. Pure so the flip / clamp logic can be tested.
 *
 * Flips above the trigger only when the menu doesn't fit below *and* there's
 * genuinely more room above — otherwise it stays below (clamped into view).
 */
export function computeMenuPlacement({
  anchor,
  menuHeight,
  menuWidth,
  viewportWidth,
  viewportHeight,
  gap = 4,
  margin = 4,
}: PlacementInput): Placement {
  const spaceBelow = viewportHeight - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap;
  const flipUp = menuHeight > spaceBelow && spaceAbove > spaceBelow;

  const top = flipUp
    ? Math.max(margin, anchor.top - gap - menuHeight)
    : anchor.bottom + gap;

  // Keep the menu within the viewport horizontally: never past the right edge,
  // never before the left margin.
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const left = Math.min(Math.max(margin, anchor.left), maxLeft);

  return { left, top, flipUp };
}

export interface FloatingMenuParams {
  /** Element the menu is positioned against (the trigger). */
  anchor: HTMLElement | undefined;
  gap?: number;
  margin?: number;
  /** Give the menu at least the anchor's width. Off for icon-sized triggers
   *  whose menu should size to its own content. Default on. */
  matchAnchorWidth?: boolean;
}

/**
 * Float a dropdown menu out of any clipping scroll-container by pinning it with
 * `position: fixed` in viewport coordinates, anchored to its trigger.
 *
 * Why: the in-cell pickers live inside `.table-scroll` (`overflow-x: auto`),
 * which the spec forces to clip on the y-axis too. A short (one-row) table then
 * clips the menu and grows a scrollbar instead of letting it spill. Fixed
 * positioning escapes that, and (re)measuring on open gives free flip-up near
 * the viewport bottom. The node stays a DOM descendant of the picker, so the
 * picker's own `contains()`-based outside-click / focusout logic still works.
 */
export const floatingMenu: Action<HTMLElement, FloatingMenuParams> = (node, params) => {
  let current = params;

  function reposition() {
    const anchor = current?.anchor;
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();

    node.style.position = 'fixed';
    node.style.margin = '0';
    if (current.matchAnchorWidth !== false) {
      node.style.minWidth = `${a.width}px`;
    }

    const { left, top } = computeMenuPlacement({
      anchor: { left: a.left, top: a.top, bottom: a.bottom, width: a.width },
      menuHeight: node.offsetHeight,
      menuWidth: node.offsetWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      gap: current.gap,
      margin: current.margin,
    });
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  reposition();

  const onViewportChange = () => reposition();
  // capture:true so scrolling of the inner table container (not just window)
  // also repositions the menu.
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });

  return {
    update(next: FloatingMenuParams) {
      current = next;
      reposition();
    },
    destroy() {
      window.removeEventListener('scroll', onViewportChange, { capture: true });
      window.removeEventListener('resize', onViewportChange);
    },
  };
};

import { readable } from 'svelte/store';

/**
 * Reactive viewport helpers. `isMobile` mirrors the ≤640px breakpoint the data
 * tables use to re-flow into one card per row — so component logic (per-card edit
 * mode, disabling the keyboard grid) can branch on the same threshold the CSS does.
 *
 * SSR-safe: defaults to `false` (desktop) when there's no `window`, and only
 * attaches the media-query listener once something subscribes.
 */
const MOBILE_QUERY = '(max-width: 640px)';

export const isMobile = readable(false, (set) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return;
  }
  const mql = window.matchMedia(MOBILE_QUERY);
  set(mql.matches);
  const onChange = (e: MediaQueryListEvent) => set(e.matches);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
});

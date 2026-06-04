// Svelte action: trap keyboard focus inside an element for as long as it is
// mounted.
//
// The blocking sync modals (own-migration, foreign-migration-in-progress)
// render a full-screen backdrop that already swallows *pointer* events — but
// the backdrop does nothing for the keyboard. Without this, a user could Tab
// out to a control behind the modal and edit data mid-migration, defeating the
// gate. This keeps Tab / Shift+Tab cycling within the modal and pulls focus
// back in if it ever lands outside, so the modal is the only reachable surface.
// The previously-focused element is restored on teardown.
//
// Apply to the dialog element, and give that element `tabindex="-1"` so it can
// hold focus itself when it has no focusable children (e.g. the wait-only
// progress modal whose only button is disabled).

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusTrap(node: HTMLElement) {
  // SSR / non-DOM guard — actions don't run on the server, but keep this safe
  // for any test or environment without a document.
  if (typeof document === 'undefined') return;

  const previouslyFocused = document.activeElement as HTMLElement | null;

  function focusable(): HTMLElement[] {
    return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  // Move focus into the modal on mount. Respect an explicit autofocus target
  // (the passphrase field declares one) so we don't fight it; otherwise the
  // first focusable, falling back to the dialog itself.
  function focusInitial() {
    const autofocus = node.querySelector<HTMLElement>('[autofocus]');
    (autofocus ?? focusable()[0] ?? node).focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) {
      // Nothing tabbable inside (wait-only modal): pin focus to the dialog so
      // Tab can't walk into the background.
      event.preventDefault();
      node.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!node.contains(active)) {
      // Focus has escaped the modal — yank it back to the first control.
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  focusInitial();
  // Capture phase, on `document`, so we intercept Tab even when focus has
  // already escaped to a background element (a bubble listener on `node` would
  // never see that keystroke).
  document.addEventListener('keydown', onKeydown, true);

  return {
    destroy() {
      document.removeEventListener('keydown', onKeydown, true);
      previouslyFocused?.focus?.();
    },
  };
}

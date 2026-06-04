// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusTrap } from './focusTrap';

function tab(shift = false): void {
  // The action listens in the capture phase on `document`; dispatching there
  // mirrors a real Tab keystroke reaching the document before any default.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }));
}

describe('focusTrap', () => {
  let outside: HTMLButtonElement;
  let modal: HTMLDivElement;
  let first: HTMLButtonElement;
  let last: HTMLButtonElement;
  let handle: { destroy(): void } | void;

  beforeEach(() => {
    document.body.innerHTML = '';

    outside = document.createElement('button');
    outside.textContent = 'background';
    document.body.appendChild(outside);
    outside.focus(); // focus starts OUTSIDE the modal

    modal = document.createElement('div');
    modal.setAttribute('tabindex', '-1');
    first = document.createElement('button');
    first.textContent = 'first';
    last = document.createElement('button');
    last.textContent = 'last';
    modal.append(first, last);
    document.body.appendChild(modal);
  });

  afterEach(() => {
    if (handle && typeof handle.destroy === 'function') handle.destroy();
  });

  it('moves focus into the modal on mount', () => {
    handle = focusTrap(modal);
    expect(document.activeElement).toBe(first);
  });

  it('respects an explicit autofocus target on mount', () => {
    last.setAttribute('autofocus', '');
    handle = focusTrap(modal);
    expect(document.activeElement).toBe(last);
  });

  it('wraps Tab from the last element back to the first', () => {
    handle = focusTrap(modal);
    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first element to the last', () => {
    handle = focusTrap(modal);
    first.focus();
    tab(true);
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back inside when it has escaped to a background element', () => {
    handle = focusTrap(modal);
    outside.focus(); // simulate focus leaking out behind the modal
    tab();
    expect(document.activeElement).toBe(first);
  });

  it('pins focus to the dialog when nothing inside is tabbable', () => {
    first.disabled = true;
    last.disabled = true;
    handle = focusTrap(modal);
    // No tabbable child → mount focuses the dialog itself.
    expect(document.activeElement).toBe(modal);
    outside.focus();
    tab();
    expect(document.activeElement).toBe(modal);
  });

  it('stops trapping and restores prior focus after destroy', () => {
    handle = focusTrap(modal);
    expect(document.activeElement).toBe(first);
    (handle as { destroy(): void }).destroy();
    handle = undefined;
    // Focus returned to where it was before the trap.
    expect(document.activeElement).toBe(outside);
    // Listener removed: a Tab no longer yanks focus back in.
    outside.focus();
    tab();
    expect(document.activeElement).toBe(outside);
  });
});

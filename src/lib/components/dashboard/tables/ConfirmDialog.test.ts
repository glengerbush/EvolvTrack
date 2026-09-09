// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ConfirmDialog from './ConfirmDialog.svelte';

describe('ConfirmDialog focus management', () => {
  let host: HTMLElement;
  let opener: HTMLButtonElement;
  let component: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    document.body.innerHTML = '<button id="opener">Delete row</button><div id="host"></div>';
    opener = document.getElementById('opener') as HTMLButtonElement;
    host = document.getElementById('host') as HTMLElement;
    opener.focus();
    component = mount(ConfirmDialog, {
      target: host,
      props: {
        title: 'Delete this row?',
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    flushSync();
  });

  afterEach(() => {
    if (component) unmount(component);
  });

  it('focuses the safe cancel action first', () => {
    expect(document.activeElement?.textContent).toBe('Cancel');
  });

  it('wraps Tab within the dialog', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement?.textContent).toBe('Delete');
  });

  it('restores focus to the opener when closed', () => {
    unmount(component!);
    component = undefined;
    expect(document.activeElement).toBe(opener);
  });
});

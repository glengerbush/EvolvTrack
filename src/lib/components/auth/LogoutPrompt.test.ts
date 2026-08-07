// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { PendingOutgoingChanges } from '$lib/sync/pending-outgoing-changes';

const LogoutPrompt = (await import('./LogoutPrompt.svelte')).default;

const summary: PendingOutgoingChanges = {
  total: 4,
  healthEntries: 2,
  vials: 1,
  settings: 1,
};

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe('LogoutPrompt', () => {
  let host: HTMLElement;
  let component: ReturnType<typeof mount>;
  const onSync = vi.fn();
  const onDiscard = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host') as HTMLElement;
    onSync.mockReset();
    onDiscard.mockReset();
    onCancel.mockReset();
  });

  afterEach(() => {
    unmount(component);
  });

  function render(error: string | null = null) {
    component = mount(LogoutPrompt, {
      target: host,
      props: { pending: summary, error, busy: false, onSync, onDiscard, onCancel },
    });
    flushSync();
  }

  it('shows total and grouped pending changes', () => {
    render();
    expect(host.textContent).toContain('4 changes haven’t synced');
    expect(host.textContent).toContain('2 Health Entries');
    expect(host.textContent).toContain('1 Vial');
    expect(host.textContent).toContain('1 settings change');
  });

  it('offers explicit sync, destructive, and cancel choices', () => {
    render();
    button(host, 'Sync and log out').click();
    button(host, 'Log out and lose changes').click();
    button(host, 'Cancel').click();
    expect(onSync).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps the destructive label static and makes sync retryable after failure', () => {
    render('Sync is offline.');
    expect(host.textContent).toContain('Sync is offline.');
    expect(button(host, 'Try sync again')).toBeDefined();
    expect(button(host, 'Log out and lose changes')).toBeDefined();
  });
});

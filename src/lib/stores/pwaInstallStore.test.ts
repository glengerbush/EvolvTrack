// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

// The store reads `browser` to decide whether to attach listeners.
vi.mock('$app/environment', () => ({ browser: true }));

import {
  canInstall,
  initInstallPrompt,
  promptInstall,
  installDismissed,
  dismissInstallBanner,
} from './pwaInstallStore';

/**
 * Build a stand-in for the Chromium-only `beforeinstallprompt` event with the
 * two members the store touches: a spy-able `prompt()` and a `userChoice` that
 * resolves to the given outcome.
 */
function makeInstallEvent(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string; platform: string }>;
  };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome, platform: 'web' });
  return event;
}

describe('pwaInstallStore', () => {
  beforeEach(() => {
    // Not running as an installed app, so init proceeds to attach listeners.
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  });

  it('captures the prompt, installs, re-arms, and clears on appinstalled', async () => {
    // Nothing installable yet.
    expect(get(canInstall)).toBe(false);
    expect(await promptInstall()).toBeNull();

    initInstallPrompt();

    // The browser signals installability: we stash the event (suppressing the
    // legacy mini-infobar) and surface our button.
    const first = makeInstallEvent('accepted');
    const prevent = vi.spyOn(first, 'preventDefault');
    window.dispatchEvent(first);
    expect(prevent).toHaveBeenCalled();
    expect(get(canInstall)).toBe(true);

    // Accepting fires the native prompt and consumes the single-use event.
    expect(await promptInstall()).toBe('accepted');
    expect(first.prompt).toHaveBeenCalledOnce();
    expect(get(canInstall)).toBe(false);
    expect(await promptInstall()).toBeNull();

    // Chromium re-fires the event while still installable; a dismissal also
    // clears the button (the event can't be reused).
    const second = makeInstallEvent('dismissed');
    window.dispatchEvent(second);
    expect(get(canInstall)).toBe(true);
    expect(await promptInstall()).toBe('dismissed');
    expect(get(canInstall)).toBe(false);

    // A later install (via our button or the browser's own UI) keeps it hidden.
    window.dispatchEvent(makeInstallEvent('accepted'));
    expect(get(canInstall)).toBe(true);
    window.dispatchEvent(new Event('appinstalled'));
    expect(get(canInstall)).toBe(false);
  });

  it('persists banner dismissal', () => {
    expect(get(installDismissed)).toBe(false);
    dismissInstallBanner();
    expect(get(installDismissed)).toBe(true);
    expect(localStorage.getItem('evolvtrack:installDismissed')).toBe('1');
  });
});

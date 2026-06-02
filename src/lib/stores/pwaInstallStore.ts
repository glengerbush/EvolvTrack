import { writable } from 'svelte/store';
import { browser } from '$app/environment';

// `beforeinstallprompt` is a non-standard, Chromium-only event (Chrome/Edge on
// desktop and Android). It isn't in the DOM lib typings, so we describe just
// the parts we use. On iOS Safari and Firefox the event never fires, so the
// install button never shows and users follow the manual FAQ steps instead.
interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = 'evolvtrack:installDismissed';

let deferred: BeforeInstallPromptEvent | null = null;
let initialized = false;

/**
 * True only when the browser has signalled that the app is installable and it
 * isn't already installed. Components subscribe to this to show an install
 * button; it stays false anywhere the native prompt isn't available.
 */
export const canInstall = writable(false);

function loadDismissed(): boolean {
  if (!browser) return false;
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the user has dismissed the install *banner*. Persisted so it doesn't
 * nag on every load. Independent of `canInstall` (the in-FAQ button ignores it,
 * since opening that question is itself an install intent).
 */
export const installDismissed = writable(loadDismissed());

/** Hide the install banner for good (persisted across loads). */
export function dismissInstallBanner() {
  installDismissed.set(true);
  if (!browser) return;
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // localStorage unavailable (private mode, quota); dismissal lasts the session.
  }
}

// Already running as an installed app? Then there's nothing to prompt.
function isStandalone(): boolean {
  if (!browser) return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return window.matchMedia?.('(display-mode: standalone)').matches || iosStandalone;
}

/**
 * Attach the install-prompt listeners. Safe to call multiple times (the first
 * call wins); intended to run once at app startup so the event — which fires
 * shortly after load — is captured before any consumer mounts.
 */
export function initInstallPrompt() {
  if (!browser || initialized) return;
  initialized = true;
  if (isStandalone()) return;

  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress Chrome's legacy mini-infobar; we surface our own button and
    // trigger the prompt from a user gesture in promptInstall().
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    canInstall.set(true);
  });

  // Fired after a successful install (via our button or the browser's own UI).
  window.addEventListener('appinstalled', () => {
    deferred = null;
    canInstall.set(false);
  });
}

/**
 * Show the native install dialog and resolve with the user's choice, or null
 * when no prompt is available. Must be called from a user gesture (e.g. a
 * click). The captured event is single-use, so `canInstall` is cleared after;
 * Chromium re-fires `beforeinstallprompt` later if the app is still installable.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
  if (!deferred) return null;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  canInstall.set(false);
  return outcome;
}

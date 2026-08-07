import { browser } from '$app/environment';
import {
  getPendingDeviceDataErasure,
  resumePendingDeviceDataErasure,
} from '$lib/security/device-data-erasure';

function renderBlockedErasure(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : 'Stored app data could not be removed.';
  const screen = document.createElement('main');
  screen.setAttribute('role', 'alert');
  screen.style.cssText = [
    'min-height:100dvh',
    'display:grid',
    'place-items:center',
    'padding:2rem',
    'font-family:system-ui,sans-serif',
    'background:#f7f7f5',
    'color:#20201e',
  ].join(';');

  const panel = document.createElement('section');
  panel.style.cssText = 'max-width:32rem;padding:1.5rem;border:1px solid #ccc;border-radius:1rem;background:white';
  const title = document.createElement('h1');
  title.textContent = 'Finishing removal from this app';
  const guidance = document.createElement('p');
  guidance.textContent = 'EvolvTrack must finish removing stored data before it can open. Close other EvolvTrack tabs, then retry.';
  const detail = document.createElement('p');
  detail.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry removal';
  retry.addEventListener('click', () => window.location.reload());
  panel.append(title, guidance, detail, retry);
  screen.append(panel);
  document.body.replaceChildren(screen);

  if (!import.meta.env.VITEST) {
    window.setTimeout(() => window.location.reload(), 5000);
  }
}

/** Resume committed Device Data Erasure before any normal app initialization. */
export async function init(): Promise<void> {
  if (!browser) return;
  try {
    const marker = await getPendingDeviceDataErasure();
    if (marker?.phase === 'account-deletion-prepared') {
      const { resumePreparedAccountDeletion } = await import('$lib/auth/supabase');
      await resumePreparedAccountDeletion();
      return;
    }
    await resumePendingDeviceDataErasure();
  } catch (cause) {
    renderBlockedErasure(cause);
    throw cause;
  }
}

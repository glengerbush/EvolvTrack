import { writable } from 'svelte/store';

export const passphraseUnlocked = writable(false);
export const offline = writable(false);

if (typeof window !== 'undefined') {
  offline.set(!navigator.onLine);
  window.addEventListener('online', () => offline.set(false));
  window.addEventListener('offline', () => offline.set(true));
}

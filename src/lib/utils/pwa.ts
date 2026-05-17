import { browser, dev } from '$app/environment';
import { writable, get } from 'svelte/store';

export const updateAvailable = writable<ServiceWorker | null>(null);

export function registerServiceWorker() {
  if (!browser || !('serviceWorker' in navigator)) return;

  if (dev) {
    void removeDevelopmentServiceWorkers();
    return;
  }

  void (async () => {
    const registration = await navigator.serviceWorker.register('/service-worker.js', {
      type: 'module'
    });

    function checkWaiting() {
      if (registration.waiting && navigator.serviceWorker.controller) {
        updateAvailable.set(registration.waiting);
      }
    }

    checkWaiting();

    registration.addEventListener('updatefound', () => {
      const sw = registration.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed') checkWaiting();
      });
    });
  })();
}

export function applyUpdate() {
  const sw = get(updateAvailable);
  if (!sw) return;
  sw.postMessage({ type: 'SKIP_WAITING' });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  }, { once: true });
}

async function removeDevelopmentServiceWorkers() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  if ('caches' in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith('evolvtrack-'))
        .map((cacheName) => caches.delete(cacheName))
    );
  }
}

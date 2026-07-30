import { browser, dev } from '$app/environment';
import { base } from '$app/paths';

export function registerServiceWorker() {
  if (!browser || !('serviceWorker' in navigator)) return;

  if (dev) {
    void removeDevelopmentServiceWorkers().catch((cause) => {
      console.warn('Failed to remove development service-worker state:', cause);
    });
    return;
  }

  void navigator.serviceWorker
    .register(`${base}/service-worker.js`, { type: 'module' })
    .catch((cause) => {
      console.warn('Service-worker registration failed:', cause);
    });
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

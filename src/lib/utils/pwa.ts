import { browser, dev } from '$app/environment';

export function registerServiceWorker() {
  if (!browser || !('serviceWorker' in navigator)) return;

  if (dev) {
    void removeDevelopmentServiceWorkers();
    return;
  }

  void navigator.serviceWorker.register('/service-worker.js', { type: 'module' });
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

import { writable } from 'svelte/store';
import { seedDemoData, clearDemoData } from '$lib/db/seed';

const STORAGE_KEY = 'evolvtrack-demo-mode';

function getInitial(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

const _isDemoMode = writable<boolean>(getInitial());

export const isDemoMode = {
  subscribe: _isDemoMode.subscribe,
  async enable() {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, 'true');
    }
    _isDemoMode.set(true);
    await seedDemoData();
  },
  async disable() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
    _isDemoMode.set(false);
    await clearDemoData();
  },
};

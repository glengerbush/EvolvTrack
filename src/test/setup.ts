// Node 25 ships a built-in `localStorage` global that's a useless stub (no
// `.clear()`, no real `.setItem`/`.getItem` semantics) and shadows whatever
// happy-dom would install. Replace it with a tiny in-memory Storage impl that
// matches the web spec well enough for unit tests.
//
// This is also where to mount any other globals tests rely on.

import { beforeEach } from 'vitest';
import { __resetClockForTests } from '$lib/sync/clock';

// The server-anchored clock keeps a module-global monotonic high-water mark.
// Reset it before each test so a fake-timer test in one case can't leave a
// future peak that "holds" a later test's timestamps (silent ordering flakes).
beforeEach(() => {
  __resetClockForTests();
});

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(String(key), String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
}

function install(name: 'localStorage' | 'sessionStorage') {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
  }
}

install('localStorage');
install('sessionStorage');

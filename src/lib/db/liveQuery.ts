import { browser } from '$app/environment';
import { liveQuery } from 'dexie';
import { readable } from 'svelte/store';

export function fromLiveQuery<T>(querier: () => Promise<T>, initial: T) {
  if (!browser) return readable(initial);
  return readable<T>(initial, (set) => {
    const sub = liveQuery(querier).subscribe({
      next: set,
      error: (e) => console.error('liveQuery error:', e),
    });
    return () => sub.unsubscribe();
  });
}

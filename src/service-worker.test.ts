import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$service-worker', () => ({
  base: '',
  version: 'test-version',
  build: ['/_app/immutable/start.js', '/_app/immutable/app.js'],
}));

type FetchEventHarness = {
  request: Request;
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (work: Promise<unknown>) => void;
};

async function loadWorker(cachedPaths: Record<string, string> = {}) {
  vi.resetModules();
  const origin = 'https://evolvtrack.test';
  const entries = new Map(Object.entries(cachedPaths).map(([path, body]) => [
    new URL(path, origin).href, new Response(body),
  ]));
  const key = (request: Request | string) => new URL(
    typeof request === 'string' ? request : request.url, origin,
  ).href;
  const cache = {
    match: vi.fn(async (request: Request | string) => entries.get(key(request))?.clone()),
    put: vi.fn(async (request: Request | string, response: Response) => {
      entries.set(key(request), response.clone());
    }),
    addAll: vi.fn(async () => {}),
  };
  const handlers = new Map<string, (event: FetchEventHarness) => void>();
  vi.stubGlobal('self', {
    location: new URL(origin),
    addEventListener: (type: string, handler: (event: FetchEventHarness) => void) => {
      handlers.set(type, handler);
    },
  });
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  // Keep the worker's no-default-lib directive out of the app's TS program.
  const workerModule = './service-worker.ts';
  await import(workerModule);

  function navigate(path: string) {
    const request = new Request(new URL(path, origin));
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    let response: Promise<Response> | undefined;
    const background: Promise<unknown>[] = [];
    handlers.get('fetch')!({
      request,
      respondWith: (value) => { response = value; },
      waitUntil: (value) => { background.push(value); },
    });
    return { response: response!, background };
  }
  async function install() {
    const pending: Promise<unknown>[] = [];
    handlers.get('install')!({
      request: new Request(origin),
      respondWith: () => {},
      waitUntil: (work) => { pending.push(work); },
    });
    await Promise.all(pending);
  }
  return { cache, navigate, install };
}

afterEach(() => vi.unstubAllGlobals());

describe('PWA reopening', () => {
  it('serves the cached dashboard without waiting for a stalled network', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const worker = await loadWorker({ '/app': 'saved dashboard', '/': 'homepage' });
    let body: string | undefined;
    void worker.navigate('/app').response.then(async (response) => { body = await response.text(); });
    await vi.waitFor(() => expect(body).toBe('saved dashboard'));
  });

  it.each(['/auth', '/app', '/app/medication'])('opens %s from the installed shell offline', async (path) => {
    const network = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', network);
    const worker = await loadWorker({ '/index.html': 'installed app shell' });
    const response = await worker.navigate(path).response;
    expect(await response.text()).toBe('installed app shell');
    expect(network).not.toHaveBeenCalled();
  });

  it('installs the app shell and code needed to reopen offline', async () => {
    const worker = await loadWorker();
    await worker.install();
    expect(worker.cache.addAll).toHaveBeenCalledWith(expect.arrayContaining([
      '/index.html', '/_app/immutable/start.js', '/_app/immutable/app.js',
    ]));
  });

  it('fetches and caches navigation when the local cache is missing', async () => {
    const network = vi.fn().mockResolvedValue(new Response('downloaded app'));
    vi.stubGlobal('fetch', network);
    const worker = await loadWorker();
    expect(await (await worker.navigate('/app').response).text()).toBe('downloaded app');
    network.mockRejectedValue(new Error('offline'));
    expect(await (await worker.navigate('/app').response).text()).toBe('downloaded app');
    expect(network).toHaveBeenCalledTimes(1);
  });
});

import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

async function loadWorker(cachedPaths: Record<string, string | Response> = {}) {
  vi.resetModules();
  const origin = 'https://evolvtrack.test';
  const entries = new Map(Object.entries(cachedPaths).map(([path, body]) => [
    new URL(path, origin).href, typeof body === 'string' ? new Response(body) : body,
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
    const request = new Request(new URL(path, origin), { redirect: 'manual' });
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
  // Real HTTP redirects retain their URL history through Response.clone(),
  // like Cache Storage. Synthetic Response fixtures cannot reproduce this.
  const server = createServer((request, response) => {
    if (request.url === '/index.html') {
      response.writeHead(302, { Location: '/' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'X-Shell': 'installed' });
    response.end('<html>installed app shell</html>');
  });
  let redirectedShell: Response;
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    redirectedShell = await fetch(`http://127.0.0.1:${address.port}/index.html`);
    expect(redirectedShell.redirected).toBe(true);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it.each(['/index.html', '/auth'])('reopens offline when cached %s was fetched through a redirect', async (cachedPath) => {
    const network = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', network);
    const worker = await loadWorker({ [cachedPath]: redirectedShell.clone() });
    const response = await worker.navigate('/auth').response;
    // WebKit rejects redirected responses to navigation requests with this error.
    expect(response.redirected, 'Response served by service worker has redirections').toBe(false);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(response.headers.get('X-Shell')).toBe('installed');
    expect(await response.text()).toBe('<html>installed app shell</html>');
    expect(network).not.toHaveBeenCalled();
  });

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

  it('leaves live navigation redirects for the browser to follow', async () => {
    const redirect = Response.redirect('https://evolvtrack.test/auth', 307);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(redirect));
    const worker = await loadWorker();
    const response = await worker.navigate('/app').response;
    expect(response).toBe(redirect);
    expect(response.headers.get('Location')).toBe('https://evolvtrack.test/auth');
    expect(worker.cache.put).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

// Capture every Worker instance constructed so tests can drive its onmessage.
type Posted = { id: string; type: string; payload: unknown };

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Posted[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  terminated = false;

  constructor(public url: unknown, public options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: Posted) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  // Helper for tests — not part of the real Worker API.
  respond(message: { id: string; ok: true; data: unknown } | { id: string; ok: false; error: string }) {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
  // Reset the module cache so each test gets a fresh singleton inside worker-client.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cryptoWorker.call', () => {
  it('constructs a single Worker lazily on the first call and reuses it', async () => {
    const { cryptoWorker } = await import('./worker-client');

    const p1 = cryptoWorker.call('derive-key', { passphrase: 'pw', saltB64: 'SALT', iterations: 600_000 });
    expect(FakeWorker.instances).toHaveLength(1);

    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0].type).toBe('derive-key');
    expect(worker.posted[0].payload).toEqual({ passphrase: 'pw', saltB64: 'SALT', iterations: 600_000 });

    // Resolve the first call so it doesn't dangle.
    worker.respond({ id: worker.posted[0].id, ok: true, data: { keyB64: 'S' } });
    await p1;

    // Second call — should not create a new Worker.
    const p2 = cryptoWorker.call('encrypt', { keyB64: 'K', plaintext: 'x' });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.posted).toHaveLength(2);
    worker.respond({ id: worker.posted[1].id, ok: true, data: { ciphertext: 'c', iv: 'i' } });
    await p2;
  });

  it('configures the worker as a module', async () => {
    const { cryptoWorker } = await import('./worker-client');
    void cryptoWorker.call('derive-key', { passphrase: 'pw', saltB64: 'SALT', iterations: 600_000 });
    expect(FakeWorker.instances[0].options).toEqual({ type: 'module' });
  });

  it('routes a successful response back to the matching call', async () => {
    const { cryptoWorker } = await import('./worker-client');

    const promise = cryptoWorker.call('derive-key', { passphrase: 'pw', saltB64: 'SALT', iterations: 600_000 });
    const worker = FakeWorker.instances[0];
    const { id } = worker.posted[0];
    worker.respond({ id, ok: true, data: { keyB64: 'OK' } });

    await expect(promise).resolves.toEqual({ keyB64: 'OK' });
  });

  it('rejects with an Error when the worker reports an error', async () => {
    const { cryptoWorker } = await import('./worker-client');

    const promise = cryptoWorker.call('decrypt', {
      keyB64: 'K',
      ciphertext: 'c',
      iv: 'i',
    });
    const worker = FakeWorker.instances[0];
    const { id } = worker.posted[0];
    worker.respond({ id, ok: false, error: 'bad-tag' });

    await expect(promise).rejects.toThrow('bad-tag');
  });

  it('ignores responses with unknown ids (does not throw)', async () => {
    const { cryptoWorker } = await import('./worker-client');

    const promise = cryptoWorker.call('derive-key', { passphrase: 'pw', saltB64: 'SALT', iterations: 600_000 });
    const worker = FakeWorker.instances[0];
    worker.respond({ id: 'not-a-real-id', ok: true, data: { keyB64: 'X' } });

    // Now answer the real call so the test doesn't hang.
    worker.respond({ id: worker.posted[0].id, ok: true, data: { keyB64: 'real' } });
    await expect(promise).resolves.toEqual({ keyB64: 'real' });
  });

  it('routes concurrent calls to their own promises (no cross-talk)', async () => {
    const { cryptoWorker } = await import('./worker-client');

    const p1 = cryptoWorker.call('derive-key', { passphrase: 'a', saltB64: 'SALT', iterations: 600_000 });
    const p2 = cryptoWorker.call('derive-key', { passphrase: 'b', saltB64: 'SALT', iterations: 600_000 });

    const worker = FakeWorker.instances[0];
    expect(worker.posted).toHaveLength(2);
    // Respond out of order to prove ids are honored.
    worker.respond({ id: worker.posted[1].id, ok: true, data: { keyB64: 'B' } });
    worker.respond({ id: worker.posted[0].id, ok: true, data: { keyB64: 'A' } });

    await expect(p1).resolves.toEqual({ keyB64: 'A' });
    await expect(p2).resolves.toEqual({ keyB64: 'B' });
  });
});

describe('cryptoWorker.call (non-browser)', () => {
  it('throws when invoked outside a browser context', async () => {
    vi.resetModules();
    vi.doMock('$app/environment', () => ({ browser: false }));
    const { cryptoWorker } = await import('./worker-client');
    expect(() => cryptoWorker.call('derive-key', { passphrase: 'pw', saltB64: 'SALT', iterations: 600_000 })).toThrow(/only available in the browser/i);
    vi.doUnmock('$app/environment');
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

type Environment = { browser: boolean; dev: boolean };

async function loadPwa(environment: Environment) {
  vi.resetModules();
  vi.doMock('$app/environment', () => environment);
  vi.doMock('$app/paths', () => ({
    base: '/base',
  }));
  return import('./pwa');
}

function installServiceWorker(register = vi.fn(), getRegistrations = vi.fn()) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register, getRegistrations },
  });
  return { register, getRegistrations };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('$app/environment');
  vi.doUnmock('$app/paths');
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(globalThis, 'caches');
  Reflect.deleteProperty(window, 'caches');
});

describe('registerServiceWorker', () => {
  it('does nothing during SSR', async () => {
    const { register } = installServiceWorker(vi.fn());
    const { registerServiceWorker } = await loadPwa({ browser: false, dev: false });

    registerServiceWorker();

    expect(register).not.toHaveBeenCalled();
  });

  it('does nothing when the browser lacks service-worker support', async () => {
    const { registerServiceWorker } = await loadPwa({ browser: true, dev: false });

    expect(() => registerServiceWorker()).not.toThrow();
  });

  it('registers the module worker at the base-aware path in production', async () => {
    const register = vi.fn().mockResolvedValue({});
    installServiceWorker(register);
    const { registerServiceWorker } = await loadPwa({ browser: true, dev: false });

    registerServiceWorker();
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith('/base/service-worker.js', {
        type: 'module',
      });
    });
  });

  it('contains production registration failures instead of creating an unhandled rejection', async () => {
    const failure = new Error('registration blocked');
    installServiceWorker(vi.fn().mockRejectedValue(failure));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registerServiceWorker } = await loadPwa({ browser: true, dev: false });

    registerServiceWorker();
    await vi.waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        'Service-worker registration failed:',
        failure,
      );
    });
  });

  it('unregisters workers and removes only EvolvTrack caches during development', async () => {
    const unregisterOne = vi.fn().mockResolvedValue(true);
    const unregisterTwo = vi.fn().mockResolvedValue(true);
    const { register, getRegistrations } = installServiceWorker(
      vi.fn(),
      vi.fn().mockResolvedValue([
        { unregister: unregisterOne },
        { unregister: unregisterTwo },
      ]),
    );
    const deleteCache = vi.fn().mockResolvedValue(true);
    const cacheStorage = {
      keys: vi.fn().mockResolvedValue(['evolvtrack-old', 'other-app']),
      delete: deleteCache,
    };
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: cacheStorage,
    });
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: cacheStorage,
    });
    const { registerServiceWorker } = await loadPwa({ browser: true, dev: true });

    registerServiceWorker();
    await vi.waitFor(() => {
      expect(unregisterOne).toHaveBeenCalledOnce();
      expect(unregisterTwo).toHaveBeenCalledOnce();
      expect(deleteCache).toHaveBeenCalledWith('evolvtrack-old');
    });
    expect(deleteCache).not.toHaveBeenCalledWith('other-app');
    expect(getRegistrations).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
  });

  it('contains development cleanup failures', async () => {
    const failure = new Error('cleanup blocked');
    installServiceWorker(vi.fn(), vi.fn().mockRejectedValue(failure));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registerServiceWorker } = await loadPwa({ browser: true, dev: true });

    registerServiceWorker();
    await vi.waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        'Failed to remove development service-worker state:',
        failure,
      );
    });
  });
});

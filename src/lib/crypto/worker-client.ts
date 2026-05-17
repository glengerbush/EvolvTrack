import { browser } from '$app/environment';
import { nanoid } from 'nanoid';
import type {
  WorkerAction,
  WorkerPayloadMap,
  WorkerResponse,
  WorkerResultMap,
} from '$lib/crypto/worker-messages';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

class CryptoWorkerClient {
  private worker: Worker;
  private pending = new Map<string, Pending>();

  constructor() {
    this.worker = new Worker(new URL('$lib/workers/crypto.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse<WorkerAction>>) => {
      const { id } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;

      this.pending.delete(id);
      if (event.data.ok) {
        pending.resolve(event.data.data);
        return;
      }

      pending.reject(new Error(event.data.error));
    };
  }

  call<T extends WorkerAction>(type: T, payload: WorkerPayloadMap[T]): Promise<WorkerResultMap[T]> {
    const id = nanoid();
    return new Promise<WorkerResultMap[T]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as WorkerResultMap[T]),
        reject
      });
      this.worker.postMessage({ id, type, payload });
    });
  }
}

let workerClient: CryptoWorkerClient | undefined;

function getCryptoWorkerClient() {
  if (!browser) {
    throw new Error('Crypto worker is only available in the browser.');
  }

  workerClient ??= new CryptoWorkerClient();
  return workerClient;
}

export const cryptoWorker = {
  call<T extends WorkerAction>(type: T, payload: WorkerPayloadMap[T]) {
    return getCryptoWorkerClient().call(type, payload);
  },
};

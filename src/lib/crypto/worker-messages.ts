export type WorkerAction = 'encrypt' | 'decrypt' | 'derive' | 'derive-key';

export type WorkerPayloadMap = {
  derive: { passphrase: string };
  'derive-key': { passphrase: string; saltB64: string };
  encrypt: { keyB64: string; plaintext: string };
  decrypt: { keyB64: string; ciphertext: string; iv: string };
};

export type WorkerResultMap = {
  derive: { saltB64: string };
  'derive-key': { keyB64: string };
  encrypt: { ciphertext: string; iv: string };
  decrypt: { plaintext: string };
};

export type WorkerRequest<T extends WorkerAction = WorkerAction> = {
  [Action in WorkerAction]: {
    id: string;
    type: Action;
    payload: WorkerPayloadMap[Action];
  };
}[T];

export type WorkerSuccessResponse<T extends WorkerAction> = {
  id: string;
  ok: true;
  data: WorkerResultMap[T];
};

export type WorkerErrorResponse = {
  id: string;
  ok: false;
  error: string;
};

export type WorkerResponse<T extends WorkerAction = WorkerAction> =
  | WorkerSuccessResponse<T>
  | WorkerErrorResponse;

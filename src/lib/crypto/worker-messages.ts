export type WorkerAction =
  | 'encrypt'
  | 'decrypt'
  | 'derive-key'
  | 'generate-dek'
  | 'wrap-key'
  | 'unwrap-key';

export type WorkerPayloadMap = {
  'derive-key': { passphrase: string; saltB64: string };
  encrypt: { keyB64: string; plaintext: string };
  decrypt: { keyB64: string; ciphertext: string; iv: string };
  'generate-dek': Record<string, never>;
  'wrap-key': { kekB64: string; keyB64: string };
  'unwrap-key': { kekB64: string; ciphertext: string; iv: string };
};

export type WorkerResultMap = {
  'derive-key': { keyB64: string };
  encrypt: { ciphertext: string; iv: string };
  decrypt: { plaintext: string };
  'generate-dek': { dekB64: string };
  'wrap-key': { ciphertext: string; iv: string };
  'unwrap-key': { keyB64: string };
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

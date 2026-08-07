// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pending: vi.fn(),
  resume: vi.fn(),
  resumeAccountDeletion: vi.fn(),
}));

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/security/device-data-erasure', () => ({
  getPendingDeviceDataErasure: h.pending,
  resumePendingDeviceDataErasure: h.resume,
}));
vi.mock('$lib/auth/supabase', () => ({
  resumePreparedAccountDeletion: h.resumeAccountDeletion,
}));

import { init } from './hooks.client';

beforeEach(() => {
  h.pending.mockReset().mockResolvedValue(null);
  h.resume.mockReset().mockResolvedValue('none');
  h.resumeAccountDeletion.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = '';
});

describe('Device Data Erasure at boot', () => {
  it('checks durable erasure state before normal startup', async () => {
    await expect(init()).resolves.toBeUndefined();
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it('continues only after pending erasure completes', async () => {
    h.resume.mockResolvedValueOnce('complete');
    await expect(init()).resolves.toBeUndefined();
    expect(document.body.textContent).toBe('');
  });

  it('verifies a prepared account deletion before local erasure', async () => {
    h.pending.mockResolvedValueOnce({
      id: 'pending',
      operationId: 'delete-1',
      phase: 'account-deletion-prepared',
      committedAt: '2026-08-07T12:00:00.000Z',
    });

    await expect(init()).resolves.toBeUndefined();

    expect(h.resumeAccountDeletion).toHaveBeenCalledOnce();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('blocks startup and renders retry guidance when erasure fails', async () => {
    h.resume.mockRejectedValueOnce(new Error('blocked by another tab'));

    await expect(init()).rejects.toThrow('blocked by another tab');

    expect(document.body.textContent).toContain('Finishing removal');
    expect(document.body.textContent).toContain('Close other EvolvTrack tabs');
    expect(document.querySelector('button')?.textContent).toContain('Retry');
  });

  it('does not initialize account recovery or sign-in while ordinary erasure is pending', async () => {
    h.pending.mockResolvedValueOnce({
      id: 'pending',
      operationId: 'erase-1',
      phase: 'erase',
      committedAt: '2026-08-07T12:00:00.000Z',
    });
    h.resume.mockRejectedValueOnce(new Error('erasure still pending'));

    await expect(init()).rejects.toThrow('erasure still pending');

    expect(h.resumeAccountDeletion).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Finishing removal');
  });
});

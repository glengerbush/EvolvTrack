import { describe, expect, it, vi } from 'vitest';
import {
  confirmRemoveAppData,
  REMOVE_APP_DATA_CONFIRMATION,
} from './remove-app-data-confirmation';

describe('Remove app data confirmation', () => {
  it('requires the approved warning before authorizing erasure', () => {
    const confirmAction = vi.fn().mockReturnValue(false);

    expect(confirmRemoveAppData(confirmAction)).toBe(false);
    expect(confirmAction).toHaveBeenCalledWith(
      'Remove app data?\n\n' +
        'This permanently removes the health data, encryption keys, and preferences stored by this copy of EvolvTrack. ' +
        'Health data that has not been synced or exported cannot be recovered. ' +
        'Synced cloud data, other devices, and exported backup files are unchanged.',
    );
    expect(REMOVE_APP_DATA_CONFIRMATION).toBe(confirmAction.mock.calls[0][0]);
  });
});

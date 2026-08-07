export const REMOVE_APP_DATA_CONFIRMATION =
  'Remove app data?\n\n' +
  'This permanently removes the health data, encryption keys, and preferences stored by this copy of EvolvTrack. ' +
  'Health data that has not been synced or exported cannot be recovered. ' +
  'Synced cloud data, other devices, and exported backup files are unchanged.';

export function confirmRemoveAppData(confirmAction: (message: string) => boolean = confirm): boolean {
  return confirmAction(REMOVE_APP_DATA_CONFIRMATION);
}

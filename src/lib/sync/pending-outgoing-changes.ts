import { db } from '$lib/db/schema';

export type PendingOutgoingChanges = {
  total: number;
  healthEntries: number;
  vials: number;
  settings: number;
};

/** Summarize the authoritative, coalesced outbox in user-facing groups. */
export async function getPendingOutgoingChanges(): Promise<PendingOutgoingChanges> {
  const changes = await db.outbox.toArray();
  const summary: PendingOutgoingChanges = {
    total: changes.length,
    healthEntries: 0,
    vials: 0,
    settings: 0,
  };

  for (const change of changes) {
    if (change.aggregate === 'entry') summary.healthEntries += 1;
    else if (change.aggregate === 'prescription') summary.vials += 1;
    else summary.settings += 1;
  }

  return summary;
}

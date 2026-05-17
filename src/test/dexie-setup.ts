// Shared per-test setup that swaps in an in-memory IndexedDB so Dexie can run
// in Node, and resets the DB before each test so files can be parallelized.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';
import { db } from '$lib/db/schema';

async function resetDb() {
  // Clear every table; cheaper than db.delete() + re-open between tests.
  await Promise.all([
    db.weights.clear(),
    db.injections.clear(),
    db.prescriptions.clear(),
    db.profile.clear(),
    db.encrypted.clear(),
    db.migrationBackfill.clear(),
    db.outbox.clear(),
  ]);
}

beforeEach(resetDb);
afterEach(resetDb);

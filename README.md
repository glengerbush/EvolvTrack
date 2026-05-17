# EVOLVETRACK (SvelteKit PWA)

Local-first GLP-1 tracking app with offline-first UX and E2EE capable cloud sync. Installable as a PWA.

# TODO:
Make mobile friendly


## Setup

1. Install deps:
   ```bash
   npm install
   ```
2. Create `.env` containing:
   ```bash
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
   ```
3. Run dev server:
   ```bash
   npm run dev
   ```

## Stack & runtime model

  - Framework: SvelteKit with @sveltejs/adapter-static → ships as a fully static SPA. No
  server-rendered routes, no server endpoints.
  - Reactivity: Svelte 5 runes ($state, $derived, $effect). No Svelte 4 reactive statements.
  - TS strict-ish + Vite + Vitest (unit) + Playwright (e2e in tests/).
  - PWA: src/lib/utils/pwa.ts registers a service worker so the app installs and works
  offline. static/manifest.webmanifest + icons.
  - Storage tier: IndexedDB via Dexie (local-first, offline-by-default).
  - Optional backend: Supabase (auth + Postgres tables for sync rows). Cloud presence is
  opt-in; the app works fully offline.

## Sync subsystem (src/lib/sync/)

  The sync system is structured as orchestrator → engine → protocol.

     outbox-change nudge ──► sync-orchestrator.ts
                                │  (debounce ~1.2s, retry, mode dispatch)
                                ▼
                            sync-engine.ts
                         ┌────────────┐  ┌────────────┐
                         │ pushOutbox │  │pullAndApply│
                         └────────────┘  └────────────┘
                                │              │
                                ▼              ▼
                         Supabase REST + Realtime (protocol.ts envelopes)

  - sync-orchestrator.ts — singleton state machine started by +layout.svelte. Listens for
  outbox nudges, debounces, calls pushOutbox() + pullAndApply(), exposes requestSync() /
  syncNow().
  - sync-engine.ts — does the actual HTTP. Two flavors: pushPlainChanges (server sees
  plaintext) and pushEncryptedChanges (server sees only ciphertext blobs). Symmetric on the
  pull side.

## Encryption (src/lib/crypto/ + src/lib/workers/)

  End-to-end encryption runs in a Web Worker so the main thread doesn't block on PBKDF2 /
  AES-GCM:

  - worker-messages.ts — typed message protocol (encrypt | decrypt | derive,
  request/response/error variants).
  - workers/crypto.worker.ts — actual worker; lives in its own bundle.
  - worker-client.ts — promise-based RPC wrapper on top of postMessage.
  - e2ee.ts — high-level API

## Codebase style

  - Branded IsoDate everywhere DB/storage dates live; locale only at render.
  - Pure functions over classes; stores hold values, not behavior.
  - Pharmacokinetics is centralized — no inline residual math.
  - The change-event bus is the spine; do not bypass it (raw db.foo.put)
  - Sync is optional and pluggable: the SyncMode (plain | e2ee) is stored per-profile and the
  engine branches on it.
  - Tests are colocated and pure-logic-first — heavy stuff (chartModel, PK, healthStore) is
  unit-tested without Dexie; only repo and healthInputs cross the IDB boundary via
  fake-indexeddb.

## Auth mode and Supabase IaC

- Signup is designed to work with either:
  - `username + password` (username is mapped to an internal synthetic email)
  - `email + password` (real email identity).
- Login supports either:
  - password
  - magic-link by email.

To keep auth settings reproducible as IaC, this repo includes `supabase/config.toml` with local auth defaults.

## Supabase notes

RLS should allow users to read/write only rows tied to their auth UID.

The sync schema lives in Supabase CLI migrations under `supabase/migrations/`.

Sync mode is a four-state machine:
- `plain` - account has not enabled E2EE.
- `migrating_to_e2ee` - E2EE upgrade has started; normal sync pauses while encrypted backfill is prepared/uploaded.
- `e2ee` - encrypted event sync is active.
- `migrating_to_plain` - E2EE downgrade has started; normal sync pauses while plaintext events upload and encrypted events are removed.

Settings recommends a fresh backup before any E2EE change. Turning E2EE off requires the passphrase, uploads decrypted sync events to `sync_plain_events`, then deletes encrypted `sync_events` after the plaintext upload succeeds.

### Supabase migration deployment

Supabase schema changes should be added as timestamped SQL files in `supabase/migrations/`. Production deployment is handled by `.github/workflows/supabase-migrations.yml`, which runs on pushes to `main` that touch migrations and can also be started manually from GitHub Actions.

Add these GitHub Actions secrets before enabling the workflow:
- `SUPABASE_ACCESS_TOKEN` - Supabase access token for the CLI.
- `PRODUCTION_PROJECT_ID` - Supabase project ref, for example `abcdefghijklmnop`.
- `PRODUCTION_DB_PASSWORD` - production database password.

The workflow runs:
1. `supabase link --project-ref "$SUPABASE_PROJECT_ID"`
2. `supabase db push --dry-run --password "$SUPABASE_DB_PASSWORD"`
3. `supabase db push --password "$SUPABASE_DB_PASSWORD"`

For a local production deploy, run the same commands from the repository root after installing and logging into the Supabase CLI.

## Version numbers to keep in mind

  |            What            |               Where                |
  |----------------------------|------------------------------------|
  | App version                | package.json                       |
  | DB_SCHEMA_VERSION          | src/lib/db/migrations.ts           |
  | SYNC_PROTOCOL_VERSION      | src/lib/sync/protocol.ts           |
  | ENCRYPTION_FORMAT_VERSION  | src/lib/crypto/e2ee.ts             |
  | BACKUP_FORMAT_VERSION      | src/lib/importExport/backup.ts     |
  | SPREADSHEET_FORMAT_VERSION | src/lib/importExport/spreadsheet.ts|
  | keyVersion                 | per row in Dexie table `encrypted` |
  | protocol_version<br> schema_version<br> protocolVersion<br> schemaVersion| rows inPostgres tables:<br> `sync_changes_encrypted`<br> `sync_changes_plain`<br> and Dexie: `migrationBackfill`|
  | encryption_version<br> encryptionVersion| rows inPostgres tables:<br> `sync_changes_encrypted`<br> and Dexie: `migrationBackfill`|


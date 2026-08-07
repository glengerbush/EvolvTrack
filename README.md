# EVOLVETRACK

Local-first GLP-1 tracking app with offline-first UX and E2EE capable cloud sync. Installable as a PWA.

## Setup
Prerequisite: Docker must be installed and runnable without `sudo`.

1. Install deps (includes the Supabase CLI):
   ```bash
   npm install
   ```
2. Start the local stack (Postgres, Auth, Realtime, Studio, …). First run downloads ~9 containers and may take a few minutes; it auto-applies everything in `supabase/migrations/`:
   ```bash
   npm run db:start
   ```
3. The command from step 2 prints the API URL and a Publishable key. Create `.env` pointing at the local Supabase stack (use the printed values verbatim):
   ```bash
   VITE_SUPABASE_URL=http://127.0.0.1:54321
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxx
   ```
   For a hosted Supabase project, swap the URL for your project's API URL and use that project's Publishable key.
4. Run the dev server:
   ```bash
   npm run dev
   ```
   Local server should be viewable at http://localhost:5173/

5. Note:
   - `npm run db:stop` — shuts the stack down (keeps DB volume)
   - `npm run db:migrate` — apply any pending new migrations to the running local DB (non-destructive; same effect as `supabase db push` in prod)
   - `npm run db:reset` — drop and re-apply all migrations from scratch (destructive — wipes local data)
   - Studio UI: http://127.0.0.1:54323


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

  The sync system is structured as orchestrator → engine → protocol, with several
  supporting modules sitting alongside.

     outbox-change nudge ──► sync-orchestrator.ts
                                │  (debounce ~1.2s, retry, mode dispatch,
                                │   license + session-key gating)
                                ▼
                            sync-engine.ts
                         ┌────────────┐  ┌────────────┐
                         │ pushOutbox │  │pullAndApply│
                         └────────────┘  └────────────┘
                                │              │
                                ▼              ▼
                         Supabase REST + Realtime (protocol.ts envelopes)

  Core flow:
  - `sync-orchestrator.ts` — singleton started by `+layout.svelte`. Listens for outbox
  nudges, debounces (`SYNC_DEBOUNCE_MS = 1200`), and calls `pushOutbox()` + `pullAndApply()`.
  Exposes `requestSync()` / `syncNow()` and subscribes to realtime updates on
  `sync_changes_encrypted` / `sync_changes_plain`.
  - `sync-engine.ts` — does the actual HTTP. Two flavors: `pushPlainChanges` (server
  sees plaintext) and `pushEncryptedChanges` (server sees only ciphertext blobs).
  Symmetric on the pull side.
  - `protocol.ts` — wire envelopes, `SYNC_PROTOCOL_VERSION`.

  Supporting modules:
  - `account-state.ts` — observable account/sync state aggregate used by the UI pills.
  - `license.ts` — license gating; sync is a no-op for accounts without a license.
  - `pull-cursor.ts` — per-user incremental pull cursor so we don't re-fetch history.
  - `session-key.ts` — in-memory cache of the derived E2EE key for the session.
  - `e2ee-migration.ts` — drives mode transitions between `plain` / `e2ee` (and
  `migrating_to_*`).
  - `e2ee-key-rotation.test.ts` (+ runtime in `e2ee-migration.ts`) — rotates the
  per-account encryption key without losing history.
  - `wrapped-keys.ts` — wraps the E2EE data key under both the passphrase-derived
  key and the recovery-code-derived key, persisted server-side in the
  `wrapped_keys` table.

## Device Data Erasure (src/lib/security/)

  - `device-data-erasure.ts` — the sole destructive local-storage coordinator.
  It durably marks forward-only erasure, revokes runtime secrets across tabs,
  deletes health and authentication databases plus browser preferences, and
  reports completion only after verification.
  - `auth/logout.ts` — owns pending-change logout choices. It never starts sync
  before consent and never silently falls back to destructive logout.

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
  unit-tested without Dexie; only Health Data Storage and healthInputs cross the IDB boundary via
  fake-indexeddb.

## Auth mode and Supabase IaC

- Signup is designed to work with either:
  - `username + password` (username is mapped to an internal synthetic email)
  - `email + password` (real email identity).
- Login supports either:
  - password
  - magic-link by email.
- Password reset is email-only (no recovery path for username-only accounts):
  - request from the login form's "Forgot password?" affordance
  - the recovery link lands on `/auth/reset` (`src/routes/(account)/auth/reset/+page.svelte`).
- E2EE accounts also have a separate **recovery code** for unlocking the data key
  if the passphrase is lost — distinct from the login password, surfaced via
  `RecoveryUnlockModal.svelte`.

To keep auth settings reproducible as IaC, this repo includes `supabase/config.toml` with local auth defaults.

## Supabase notes (more supabase info [HERE](supabase/README.md))

RLS should allow users to read/write only rows tied to their auth UID.

The sync schema lives in Supabase CLI migrations under `supabase/migrations/`.

Sync mode is a five-state machine (see `SyncMode` in `src/lib/domain/types.ts`):
- `plain` - account has not enabled E2EE.
- `migrating_to_e2ee` - E2EE upgrade has started; normal sync pauses while encrypted backfill is prepared/uploaded.
- `e2ee` - encrypted event sync is active.
- `rotating_e2ee_key` - existing E2EE data key is being rotated; normal sync pauses while history is re-encrypted under the new key.
- `migrating_to_plain` - E2EE downgrade has started; normal sync pauses while plaintext events upload and encrypted events are removed.

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

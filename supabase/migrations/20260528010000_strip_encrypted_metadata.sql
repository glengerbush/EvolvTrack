-- Remove plaintext metadata columns from sync_changes_encrypted.
--
-- For an end-to-end encrypted account, the server has no business knowing
-- which aggregate (`weight`, `injection`, `prescription`, `profile`) a row
-- belongs to or whether it's an `upsert` vs a `delete`. Both fields are
-- already carried inside the encrypted envelope (`syncEnvelope` in
-- sync-engine.ts writes `{ aggregate, op, record }` before encryption), so
-- the on-disk columns are redundant and leak a per-user histogram of what
-- the user tracks and how often.
--
-- The `id` column (`${aggregate}:${entityId}`) still embeds the aggregate
-- plus a stable entity identifier — that's a separate, harder fix (HMAC-
-- keyed ids on a future rotation) and is intentionally not addressed here.
--
-- Deploy order: ship the client that omits these fields on push and trusts
-- the envelope on pull *before* (or simultaneous with) this migration. An
-- old client pushing `aggregate`/`op` against the new schema will fail with
-- an unknown-column error; a new client pushing against the old schema
-- would fail the NOT NULL constraint. Either way, sync pauses briefly until
-- both sides are aligned.

alter table public.sync_changes_encrypted
  drop column if exists aggregate,
  drop column if exists op;

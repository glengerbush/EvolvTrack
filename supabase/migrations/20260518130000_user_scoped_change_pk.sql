-- Make sync_changes_* primary key user-scoped.
--
-- Before: `id text primary key`. Because `id` is a global PK, any two users
-- whose outbox produced the same string would collide on insert. Per-record
-- aggregates (weight/injection/prescription) are keyed by client-minted UUIDs
-- and so are unique by luck, but the profile singleton's outbox id is the
-- literal `profile:profile` for every user. The second user to push a profile
-- under a given Supabase project would hit ON CONFLICT, fall to the UPDATE
-- path, and fail the RLS USING clause (`auth.uid() = user_id`) against the
-- other user's row — bricking the entire sync cycle for everyone but the
-- original author.
--
-- After: `(user_id, id)` is the primary key, so id namespaces are per-user by
-- construction and the singleton collision is impossible. The realtime
-- publication keeps the default replica identity (the new composite PK); no
-- realtime config changes needed. The separate (user_id, created_at) index
-- stays — it serves order-by-created_at queries, which the PK alone doesn't.

alter table public.sync_changes_encrypted
  drop constraint sync_changes_encrypted_pkey;
alter table public.sync_changes_encrypted
  add primary key (user_id, id);

alter table public.sync_changes_plain
  drop constraint sync_changes_plain_pkey;
alter table public.sync_changes_plain
  add primary key (user_id, id);

-- Store the PBKDF2 work factor each wrapped-key KEK was derived with.
--
-- The client raised PBKDF2-HMAC-SHA256 from 210,000 to 600,000 iterations
-- (OWASP 2023). Unwrapping a DEK must use the SAME iteration count the KEK was
-- wrapped under, so the count now travels with the bundle instead of being a
-- client constant. New bundles are written with 600,000; every row that existed
-- before this migration was wrapped at 210,000, which is exactly the default
-- backfilled into the new columns here.
--
-- The passphrase and recovery halves get independent counts: a recovery-code
-- rotation re-wraps only the recovery half (at the new work factor) and leaves
-- the passphrase half — and its count — untouched.

alter table public.wrapped_keys
  add column if not exists passphrase_iterations int not null default 210000,
  add column if not exists recovery_iterations  int not null default 210000;

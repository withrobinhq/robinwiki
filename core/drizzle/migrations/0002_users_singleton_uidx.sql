-- Single-tenant invariant (#audit-M1). Replaces a JS count check that has a
-- TOCTOU window with a DB-enforced guarantee that the users table holds at
-- most one row. The expression `((true))` collapses every row to the same
-- key; the second insert raises SQLSTATE 23505.
CREATE UNIQUE INDEX IF NOT EXISTS users_singleton_uidx
  ON users ((true));

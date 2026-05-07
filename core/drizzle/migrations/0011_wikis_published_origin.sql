-- Stream I Phase 4 — clickable publish URL.
-- Captures the request origin at publish time so the settings modal
-- (and any third-party caller) can build an absolute public URL even
-- when the user is on a different host than where the wiki was
-- originally published from. Nullable: legacy rows pre-Phase-4 have no
-- captured origin, and the UI falls back to window.location.origin
-- (or process.env.SERVER_PUBLIC_URL on the server) when it's null.
--
-- Idempotent.

ALTER TABLE wikis
  ADD COLUMN IF NOT EXISTS published_origin text;

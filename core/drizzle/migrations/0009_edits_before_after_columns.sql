-- Stream D / D1' — fragment edit audit emission. The existing `edits` table
-- carries one `content` column (the prior snapshot, per the wiki edit pattern
-- in core/src/routes/content.ts:165). PUT /fragments/:id now writes both the
-- prior and the new content into a single edit row so the fragment-evolution
-- timeline (Stream F4) can render diffs without re-fetching adjacent rows.
--
-- Columns are nullable for backward compatibility with the existing wiki edit
-- log, which still writes only `content`. New fragment edits populate both.

ALTER TABLE "edits" ADD COLUMN IF NOT EXISTS "content_before" text;
ALTER TABLE "edits" ADD COLUMN IF NOT EXISTS "content_after" text;

-- Search-recall fixes (issue #249).
--
-- 1. Weave fragment tags into fragments.search_vector (weight C). Tags
--    were previously absent from the vector — tag-only queries hit 0
--    rows even when the row's tags array clearly matched.
--
-- 2. Expand each trigger's UPDATE-OF column list so the vector rebuilds
--    on every column it depends on. The shipped triggers fired only on
--    a partial subset (e.g. fragments fired on title only, missing
--    content + tags) so live edits silently drifted the index.
--
-- 3. Backfill — every existing row needs its vector rebuilt once so
--    deployed data benefits from the wider source set.
--
-- All statements are idempotent (CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS) so re-running the migration is safe.

-- ─── fragments: title (A) + content (B) + tags (C) ───
CREATE OR REPLACE FUNCTION fragments_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'B') ||
    setweight(
      to_tsvector(
        'english',
        coalesce(
          (SELECT string_agg(replace(value, '-', ' '), ' ')
             FROM jsonb_array_elements_text(NEW.tags)),
          ''
        )
      ),
      'C'
    );
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS fragments_search_vector_trigger ON "fragments";--> statement-breakpoint
CREATE TRIGGER fragments_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, content, tags ON "fragments"
  FOR EACH ROW EXECUTE FUNCTION fragments_search_vector_update();--> statement-breakpoint

-- ─── wikis: name (A) + prompt + description (B) + content (C) ───
-- description was never in the vector either — adding it here so a
-- single trigger expansion covers every text source.
CREATE OR REPLACE FUNCTION wikis_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.prompt, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS wikis_search_vector_trigger ON "wikis";--> statement-breakpoint
CREATE TRIGGER wikis_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, prompt, description, content ON "wikis"
  FOR EACH ROW EXECUTE FUNCTION wikis_search_vector_update();--> statement-breakpoint

-- ─── people: name + aliases (A) + slug + relationship (B) + content (C) ───
CREATE OR REPLACE FUNCTION people_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.aliases, ' '), '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.slug, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.relationship, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS people_search_vector_trigger ON "people";--> statement-breakpoint
CREATE TRIGGER people_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, aliases, slug, relationship, content ON "people"
  FOR EACH ROW EXECUTE FUNCTION people_search_vector_update();--> statement-breakpoint

-- ─── Backfill — rebuild every existing search_vector once ───
-- Touching a vector-source column forces the BEFORE trigger to fire
-- and recompute the vector with the new column set. We pick a column
-- that's always non-null so the no-op self-assign is safe.
UPDATE "fragments" SET title = title;--> statement-breakpoint
UPDATE "wikis"     SET name  = name;--> statement-breakpoint
UPDATE "people"    SET name  = name;

-- #247 — rename wiki types: collection → research, principles → principle.
-- wiki_types is permanently single-tenant (no user_id), so the rows we care
-- about are the seeded defaults plus any user-modified copies. We do an
-- in-place UPDATE rather than DELETE+reseed: the seed-wiki-types boot step
-- preserves user_modified=true rows by slug, so changing the slug under it
-- would silently DROP the user's customizations on the old slug.
--
-- Companion code change: WikiType union now lists 'research' / 'principle'
-- (not 'collection' / 'principles'). Any FK-style references in `wikis.type`
-- must be updated too — otherwise the next regen would fail to load the
-- per-type yaml spec.

-- Update wiki_types primary identifier.
UPDATE wiki_types SET slug = 'research'  WHERE slug = 'collection';
UPDATE wiki_types SET slug = 'principle' WHERE slug = 'principles';

-- Update existing wikis.type values that reference the old slugs.
-- wikis.type is a free-text column (no FK), but the application treats it
-- as one of the WikiType enum values; bringing them back into the enum
-- keeps regen / classification / preview rendering all consistent.
UPDATE wikis SET type = 'research'  WHERE type = 'collection';
UPDATE wikis SET type = 'principle' WHERE type = 'principles';

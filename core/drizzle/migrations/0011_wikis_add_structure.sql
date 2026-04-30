-- #244 — promote per-wiki document structure to a first-class field.
-- Sibling of wikis.prompt (which is the system_message override): this
-- column carries the user's override for the wiki-type's default_structure
-- block, which the wiki-generation template now substitutes via the
-- {{structure}} placeholder. Empty string means "fall back to the type
-- default declared in the YAML spec".
ALTER TABLE "wikis" ADD COLUMN IF NOT EXISTS "structure" text NOT NULL DEFAULT '';

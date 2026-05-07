-- Wave G — wiki_types.internal_framing column.
-- Type-aware authoring instruction used by the HyDE generator. Belief
-- wikis get framed differently than Decision wikis than Skill wikis.
-- Populated on next bootstrap by the YAML loader from each wiki-type
-- spec's `internal_framing` field.
--
-- Nullable for now — bootstrap populates the v0.2.0 set.

ALTER TABLE "wiki_types"
  ADD COLUMN IF NOT EXISTS "internal_framing" text;

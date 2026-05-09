-- Canonicalize edges.src_type to raw_source for ENTRY_HAS_FRAGMENT rows.
-- Today the persist worker writes edges with src_type='entry', and the
-- seed-fixture path writes them with src_type='raw_source'. Same edge
-- type, two source-type strings. Graph traversal filters that match on
-- src_type='entry' miss half the rows; filters on src_type='raw_source'
-- miss the other half. The underlying table is `raw_sources` (renamed
-- from `entries` in v0.2.0), so raw_source is the canonical value.

UPDATE edges SET src_type = 'raw_source' WHERE src_type = 'entry';

-- Sweep any leftover non-canonical dst_type strings on the symmetric
-- direction. dst_type is always 'fragment' for ENTRY_HAS_FRAGMENT in
-- known callers, but historical rows could carry 'entry' if a writer
-- ever flipped src/dst.
UPDATE edges SET dst_type = 'raw_source' WHERE dst_type = 'entry';

-- Lock the canonical vocabulary at the schema level. Adding the CHECK
-- after the UPDATE so the constraint validates against already-canonical
-- rows. The vocabulary matches every src_type / dst_type literal written
-- by code in this repo as of v0.2.2:
--   raw_source: ENTRY_HAS_FRAGMENT.src
--   fragment:   ENTRY_HAS_FRAGMENT.dst, FRAGMENT_*.src, FRAGMENT_*.dst
--   wiki:       FRAGMENT_IN_WIKI.dst, WIKI_*.src
--   person:     FRAGMENT_MENTIONS_PERSON.dst
ALTER TABLE edges ADD CONSTRAINT edges_src_type_check
  CHECK (src_type IN ('raw_source', 'fragment', 'wiki', 'person'));

ALTER TABLE edges ADD CONSTRAINT edges_dst_type_check
  CHECK (dst_type IN ('raw_source', 'fragment', 'wiki', 'person'));

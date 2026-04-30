-- One-time backfill for #236. Edges that referenced wikis soft-deleted
-- before the DELETE-handler cascade landed are still live (deleted_at
-- IS NULL while their wiki has deleted_at IS NOT NULL). Triage observed
-- 45+ such rows. Sweep them now and let the new handler keep the
-- invariant.
UPDATE edges
SET deleted_at = now()
FROM wikis
WHERE edges.deleted_at IS NULL
  AND wikis.deleted_at IS NOT NULL
  AND (edges.src_id = wikis.lookup_key OR edges.dst_id = wikis.lookup_key);

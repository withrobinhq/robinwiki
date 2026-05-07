-- Wave G — wiki_agent_schema table (multi-row by `kind`).
-- Per docs/architecture/wiki-agent-schema.md. The agent-facing retrieval
-- surface: each kind is a different representation pathway (description,
-- hyde_synthetic, future hyde_questions / expanded_keywords / ...). New
-- representation types add rows, not columns — no schema migration needed.
--
-- Idempotent against a partial apply (CREATE TABLE / INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "wiki_agent_schema" (
  "wiki_key" text NOT NULL REFERENCES "wikis"("lookup_key") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "content" text NOT NULL,
  "embedding" vector(1536),
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "generator_version" text NOT NULL,
  PRIMARY KEY ("wiki_key", "kind")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_agent_schema_embedding_idx"
  ON "wiki_agent_schema"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_agent_schema_kind_idx" ON "wiki_agent_schema" ("kind");

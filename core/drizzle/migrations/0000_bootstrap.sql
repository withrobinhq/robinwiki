-- Bootstrap migration — squashes the original 0000_init … 0013_people_is_owner
-- chain into a single fresh-install schema. Pure data backfills (0001, 0010,
-- 0012) are intentionally omitted: seed-wiki-types runs the latest taxonomy at
-- boot, and zombie-edge backfill is a one-time fix not relevant to fresh DBs.
--
-- DEPLOY NOTE: existing deployments must wipe their DB before pulling this
-- version (see DEPLOY-NOTES.md). Drizzle's `__drizzle_migrations` tracking
-- table will see this bootstrap as un-applied and re-run it, which fails on
-- pre-existing tables.

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."object_state" AS ENUM('PENDING', 'LINKING', 'RESOLVED');--> statement-breakpoint

-- ─── Auth Tables ───

CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"image" text,
	"public_key" text DEFAULT '' NOT NULL,
	"encrypted_private_key" text DEFAULT '' NOT NULL,
	"mcp_token_version" integer DEFAULT 1 NOT NULL,
	"encrypted_dek" text DEFAULT '' NOT NULL,
	"password_reset_required" boolean DEFAULT false NOT NULL,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"onboarded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── Groups ───

CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── Configs ───

CREATE TABLE "configs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── Wiki Types ───
-- `based_on_version` was appended by the original 0002; column order preserved.

CREATE TABLE "wiki_types" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_descriptor" text DEFAULT '' NOT NULL,
	"descriptor" text DEFAULT '' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"user_modified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"based_on_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint

-- ─── Domain Tables ───

CREATE TABLE "raw_sources" (
	"lookup_key" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"state" "object_state" DEFAULT 'PENDING' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"dedup_hash" text,
	"locked_by" text,
	"locked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'thought' NOT NULL,
	"source" text DEFAULT 'api' NOT NULL,
	"source_metadata" jsonb,
	"ingest_status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp,
	"attempt_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- `embedding_attempt_count` and `embedding_last_attempt_at` were appended by
-- the original 0006; column order preserved to match the old chain.
CREATE TABLE "fragments" (
	"lookup_key" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"state" "object_state" DEFAULT 'PENDING' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"dedup_hash" text,
	"locked_by" text,
	"locked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"type" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"entry_id" text,
	"embedding" vector(1536),
	"search_vector" "tsvector",
	"embedding_attempt_count" integer DEFAULT 0 NOT NULL,
	"embedding_last_attempt_at" timestamp
);
--> statement-breakpoint
-- Later migrations appended `metadata` (0003), `citation_declarations` (0004),
-- `description` (0007), and `structure` (0011). Column order matches the old
-- chain so `SELECT *` projection stays byte-identical.
CREATE TABLE "wikis" (
	"lookup_key" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"state" "object_state" DEFAULT 'PENDING' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"dedup_hash" text,
	"locked_by" text,
	"locked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'log' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"last_rebuilt_at" timestamp,
	"published" boolean DEFAULT false NOT NULL,
	"published_slug" text,
	"published_at" timestamp,
	"regenerate" boolean DEFAULT true NOT NULL,
	"bouncer_mode" text DEFAULT 'auto' NOT NULL,
	"embedding" vector(1536),
	"search_vector" "tsvector",
	"progress" jsonb,
	"metadata" jsonb,
	"citation_declarations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"structure" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_wikis" (
	"group_id" text NOT NULL,
	"wiki_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	PRIMARY KEY ("group_id", "wiki_id")
);
--> statement-breakpoint
-- `is_owner` was appended by the original 0013; column order preserved.
CREATE TABLE "people" (
	"lookup_key" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"state" "object_state" DEFAULT 'PENDING' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"dedup_hash" text,
	"locked_by" text,
	"locked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"relationship" text DEFAULT '' NOT NULL,
	"canonical_name" text DEFAULT '' NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"last_rebuilt_at" timestamp,
	"embedding" vector(1536),
	"search_vector" "tsvector",
	"is_owner" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint

-- ─── Edits ───

CREATE TABLE "edits" (
	"id" text PRIMARY KEY NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"type" text DEFAULT 'addition' NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"diff" text DEFAULT '' NOT NULL
);
--> statement-breakpoint

-- ─── Edges ───

CREATE TABLE "edges" (
	"id" text PRIMARY KEY NOT NULL,
	"src_type" text NOT NULL,
	"src_id" text NOT NULL,
	"dst_type" text NOT NULL,
	"dst_id" text NOT NULL,
	"edge_type" text NOT NULL,
	"attrs" jsonb,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── Processed Jobs ───

CREATE TABLE "processed_jobs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"content_hash" text,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── Pipeline Events ───

CREATE TABLE "pipeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_key" text NOT NULL,
	"job_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"fragment_key" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── Audit Log ───

CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source" text,
	"summary" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── API Keys ───

CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint

-- ─── Foreign Keys ───

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fragments" ADD CONSTRAINT "fragments_entry_id_raw_sources_lookup_key_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."raw_sources"("lookup_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_wikis" ADD CONSTRAINT "group_wikis_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_wikis" ADD CONSTRAINT "group_wikis_wiki_id_wikis_lookup_key_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("lookup_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ─── Indexes ───
-- `wikis_slug_uidx` is partial on `deleted_at IS NULL` (was widened in the
-- original 0005 to let soft-deleted wikis free their slug).
-- `fragments_dedup_hash_idx` is partial on `deleted_at IS NULL` (original 0008).
-- `fragments_embedding_null_idx` was added in 0006 for retry scheduling.
-- `people_is_owner_uidx` was added in 0013 to enforce at-most-one owner.

CREATE UNIQUE INDEX "groups_slug_uidx" ON "groups" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "configs_scope_kind_key_uidx" ON "configs" USING btree ("scope","kind","key");--> statement-breakpoint
CREATE INDEX "configs_kind_idx" ON "configs" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_sources_slug_uidx" ON "raw_sources" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "raw_sources_ingest_status_idx" ON "raw_sources" USING btree ("ingest_status");--> statement-breakpoint
CREATE UNIQUE INDEX "fragments_slug_uidx" ON "fragments" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "fragments_dedup_hash_idx" ON "fragments" USING btree ("dedup_hash") WHERE "fragments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "fragments_embedding_null_idx" ON "fragments" ("embedding_last_attempt_at") WHERE "embedding" IS NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wikis_slug_uidx" ON "wikis" USING btree ("slug") WHERE "wikis"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wikis_published_slug_uidx" ON "wikis" USING btree ("published_slug");--> statement-breakpoint
CREATE INDEX "group_wikis_wiki_idx" ON "group_wikis" USING btree ("wiki_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_slug_uidx" ON "people" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "people_aliases_gin_idx" ON "people" USING gin ("aliases");--> statement-breakpoint
CREATE UNIQUE INDEX "people_is_owner_uidx" ON "people" ((is_owner)) WHERE is_owner = true AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "edits_object_idx" ON "edits" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "edges_src_dst_type_uidx" ON "edges" USING btree ("src_type","src_id","dst_type","dst_id","edge_type");--> statement-breakpoint
CREATE INDEX "edges_src_idx" ON "edges" USING btree ("src_type","src_id","edge_type");--> statement-breakpoint
CREATE INDEX "edges_dst_idx" ON "edges" USING btree ("dst_type","dst_id","edge_type");--> statement-breakpoint
CREATE INDEX "processed_jobs_content_hash_idx" ON "processed_jobs" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "processed_jobs_processed_at_idx" ON "processed_jobs" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "pipeline_events_entry_key_idx" ON "pipeline_events" USING btree ("entry_key");--> statement-breakpoint
CREATE INDEX "pipeline_events_status_stage_idx" ON "pipeline_events" USING btree ("status","stage");--> statement-breakpoint
CREATE INDEX "pipeline_events_created_at_idx" ON "pipeline_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_event_type_idx" ON "audit_log" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint

-- ─── HNSW indexes on embedding columns (cosine distance) ───

CREATE INDEX "wikis_embedding_hnsw_idx" ON "wikis" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE INDEX "fragments_embedding_hnsw_idx" ON "fragments" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE INDEX "people_embedding_hnsw_idx" ON "people" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint

-- ─── tsvector triggers and GIN indexes ───
-- These are the post-0009 versions: fragments includes tags, wikis includes
-- description, and every trigger fires on the full set of columns the vector
-- depends on. Drizzle-kit can't generate triggers from the schema DSL, so they
-- are managed here as raw SQL.

-- Wikis: name (A) + prompt + description (B) + content (C)
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

CREATE TRIGGER wikis_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, prompt, description, content ON "wikis"
  FOR EACH ROW EXECUTE FUNCTION wikis_search_vector_update();--> statement-breakpoint

CREATE INDEX "wikis_search_vector_gin_idx" ON "wikis" USING gin ("search_vector");--> statement-breakpoint

-- Fragments: title (A) + content (B) + tags (C)
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

CREATE TRIGGER fragments_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, content, tags ON "fragments"
  FOR EACH ROW EXECUTE FUNCTION fragments_search_vector_update();--> statement-breakpoint

CREATE INDEX "fragments_search_vector_gin_idx" ON "fragments" USING gin ("search_vector");--> statement-breakpoint

-- People: name + aliases (A) + slug + relationship (B) + content (C)
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

CREATE TRIGGER people_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, aliases, slug, relationship, content ON "people"
  FOR EACH ROW EXECUTE FUNCTION people_search_vector_update();--> statement-breakpoint

CREATE INDEX "people_search_vector_gin_idx" ON "people" USING gin ("search_vector");

ALTER TABLE "fragments" DROP COLUMN IF EXISTS "org_id";--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN IF EXISTS "org_id";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN IF EXISTS "org_id";--> statement-breakpoint
ALTER TABLE "wikis" DROP COLUMN IF EXISTS "org_id";

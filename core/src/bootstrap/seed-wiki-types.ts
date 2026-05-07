import { eq } from 'drizzle-orm'
import { loadWikiTypeConfigs } from '@robin/shared/prompts'
import { db } from '../db/client.js'
import { wikiTypes } from '../db/schema.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'seed-wiki-types' })

export interface SeedWikiTypesResult {
  inserted: number
  refreshed: number
  preserved: number
  failed: number
}

/**
 * Seed wiki types from YAML specs. Runs on every boot (idempotent).
 *
 * - Missing row: INSERT with isDefault=true, userModified=false,
 *   prompt=<raw YAML blob>, basedOnVersion=<spec.version>.
 * - Row exists AND userModified=false: UPDATE name/shortDescriptor/
 *   descriptor/prompt/basedOnVersion to match current YAML on disk.
 * - Row exists AND userModified=true: skip (user edits win).
 *
 * Per-config failures (YAML parse error, DB error) are logged and
 * skipped; this function never throws. If the loader itself throws
 * (e.g. specs dir missing), we log and return zero counts.
 */
export async function seedWikiTypes(): Promise<SeedWikiTypesResult> {
  const result: SeedWikiTypesResult = {
    inserted: 0,
    refreshed: 0,
    preserved: 0,
    failed: 0,
  }

  let configs: ReturnType<typeof loadWikiTypeConfigs>
  try {
    configs = loadWikiTypeConfigs()
  } catch (err) {
    log.error({ err }, 'loadWikiTypeConfigs threw — skipping seed entirely')
    return result
  }

  for (const cfg of configs) {
    try {
      const [existing] = await db
        .select({ userModified: wikiTypes.userModified })
        .from(wikiTypes)
        .where(eq(wikiTypes.slug, cfg.slug))

      if (!existing) {
        await db.insert(wikiTypes).values({
          slug: cfg.slug,
          name: cfg.displayLabel,
          shortDescriptor: cfg.displayShortDescriptor,
          descriptor: cfg.displayDescription,
          prompt: cfg.rawYaml,
          isDefault: true,
          userModified: false,
          basedOnVersion: cfg.version,
        })
        result.inserted++
      } else if (!existing.userModified) {
        await db
          .update(wikiTypes)
          .set({
            name: cfg.displayLabel,
            shortDescriptor: cfg.displayShortDescriptor,
            descriptor: cfg.displayDescription,
            prompt: cfg.rawYaml,
            basedOnVersion: cfg.version,
            updatedAt: new Date(),
          })
          .where(eq(wikiTypes.slug, cfg.slug))
        result.refreshed++
      } else {
        result.preserved++
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), slug: cfg.slug },
        'seed-wiki-types: per-config error — continuing'
      )
      result.failed++
    }
  }

  log.info(result, 'wiki types seeded')
  return result
}

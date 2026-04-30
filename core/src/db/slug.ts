import { eq } from 'drizzle-orm'
import { customAlphabet } from 'nanoid'
import { entries, fragments, people, wikis } from './schema.js'
import { checkSlugCollision } from '@robin/shared'
import type { DB } from './client.js'

const nanoid6 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6)

/**
 * @summary Resolve a unique slug for an entry, appending -2, -3 etc. on collision.
 *
 * @param database - Drizzle db instance
 * @param slug     - Candidate slug from generateSlug()
 * @returns A slug guaranteed unique in the entries table
 */
export async function resolveEntrySlug(database: DB, slug: string): Promise<string> {
  return checkSlugCollision(slug, async (candidate) => {
    const [existing] = await database
      .select({ key: entries.lookupKey })
      .from(entries)
      .where(eq(entries.slug, candidate))
      .limit(1)
    return !!existing
  })
}

/**
 * @summary Resolve a unique slug for a fragment, appending -2, -3 etc. on collision.
 *
 * @param database - Drizzle db instance
 * @param slug     - Candidate slug from generateSlug()
 * @returns A slug guaranteed unique in the fragments table
 */
export async function resolveFragmentSlug(database: DB, slug: string): Promise<string> {
  return checkSlugCollision(slug, async (candidate) => {
    const [existing] = await database
      .select({ key: fragments.lookupKey })
      .from(fragments)
      .where(eq(fragments.slug, candidate))
      .limit(1)
    return !!existing
  })
}

/**
 * @summary Resolve a unique slug for a wiki, appending a nanoid(6) suffix on collision.
 *
 * Unlike entry/fragment slug resolution (which appends -2, -3, etc.), wiki slugs
 * use a random suffix to avoid predictable URLs.
 *
 * @param database - Drizzle db instance
 * @param slug     - Candidate slug from generateSlug()
 * @returns A slug guaranteed unique in the wikis table
 */
export async function resolveWikiSlug(database: DB, slug: string): Promise<string> {
  const exists = async (candidate: string) => {
    const [row] = await database
      .select({ key: wikis.lookupKey })
      .from(wikis)
      .where(eq(wikis.slug, candidate))
      .limit(1)
    return !!row
  }

  if (!(await exists(slug))) return slug

  for (let i = 0; i < 5; i++) {
    const candidate = `${slug}-${nanoid6()}`
    if (!(await exists(candidate))) return candidate
  }

  throw new Error(`Slug collision: could not disambiguate "${slug}" after 5 attempts`)
}

/**
 * @summary Resolve a unique slug for a person, appending -2, -3 etc. on collision.
 *
 * Mirrors the entry/fragment pattern (numeric suffix, predictable). People
 * are user-visible by name so a deterministic suffix is fine. (#234)
 */
export async function resolvePersonSlug(database: DB, slug: string): Promise<string> {
  return checkSlugCollision(slug, async (candidate) => {
    const [existing] = await database
      .select({ key: people.lookupKey })
      .from(people)
      .where(eq(people.slug, candidate))
      .limit(1)
    return !!existing
  })
}

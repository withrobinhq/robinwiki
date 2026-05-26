import { and, eq, inArray } from 'drizzle-orm'
import type { WikiRef } from '@robin/shared/schemas/sidecar'
import { wikis } from '../db/schema.js'
import type { db as DBType } from '../db/client.js'

/**
 * Prepare a wiki body for the public read surface.
 *
 * Token handling for `[[kind:slug]]`:
 *   - `wiki`     : if the target is itself published, emit a markdown
 *                  link `[Label](/p/<their-published-slug>)`. Otherwise
 *                  drop the link and keep the label as plain text.
 *   - `person`   : drop the link, keep the label as plain text
 *                  (person names usually read as natural prose).
 *   - `fragment` : remove the token entirely (along with any leading
 *                  whitespace). Fragment titles often carry a date
 *                  prefix and read as noise mid-sentence.
 *   - `entry`    : remove the token entirely, same reasoning as
 *                  fragment.
 *
 * Inline citation markers (`[1]`, `[12]`) are stripped outright;
 * public readers can't open the source fragment.
 *
 * The returned content is self-contained markdown; the caller can
 * return an empty `refs` map because every surviving link is now a
 * native markdown anchor.
 */

type DB = typeof DBType

const TOKEN_RE = /\[\[([a-z]+):([a-z0-9-]+)\]\]/g
// Match an `[[kind:slug]]` token together with any whitespace that
// immediately precedes it, so removing inline citation-style tokens
// doesn't leave a stranded double-space mid-sentence.
const DROP_TOKEN_RE = /\s*\[\[(fragment|entry):([a-z0-9-]+)\]\]/g
const CITATION_RE = /\[(\d+)\]/g

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// Wiki names are free-form user content. A label like "Q4 [2026] Plan"
// would close the markdown link text early at the first ']' if dropped
// in unescaped, producing visible broken markup. Escape backslashes and
// brackets so the link label is whatever string we were given.
function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&')
}

export async function prepareContentForPublish(
  db: DB,
  content: string,
  refs: Record<string, WikiRef>
): Promise<string> {
  if (!content) return content

  // Collect wiki cross-ref slugs so we can ask the DB which ones are
  // published in a single query.
  const wikiSlugs = new Set<string>()
  for (const match of content.matchAll(TOKEN_RE)) {
    if (match[1] === 'wiki') wikiSlugs.add(match[2])
  }

  const publishedSlugBySlug = new Map<string, string>()
  if (wikiSlugs.size > 0) {
    const rows = await db
      .select({ slug: wikis.slug, publishedSlug: wikis.publishedSlug })
      .from(wikis)
      .where(
        and(
          inArray(wikis.slug, Array.from(wikiSlugs)),
          eq(wikis.published, true)
        )
      )
    for (const row of rows) {
      if (row.publishedSlug) publishedSlugBySlug.set(row.slug, row.publishedSlug)
    }
  }

  // Drop fragment / entry tokens entirely (along with leading
  // whitespace) so they don't leave inline noise.
  let result = content.replace(DROP_TOKEN_RE, '')

  // Rewrite remaining tokens (wiki + person).
  result = result.replace(TOKEN_RE, (_match, kind: string, slug: string) => {
    const ref = refs[`${kind}:${slug}`]
    const label = ref?.label ?? titleCase(slug)
    if (kind === 'wiki') {
      const publishedSlug = publishedSlugBySlug.get(slug)
      if (publishedSlug) return `[${escapeMarkdownLinkLabel(label)}](/p/${publishedSlug})`
    }
    return label
  })

  // Strip inline citation markers [N].
  result = result.replace(CITATION_RE, '')

  return result
}

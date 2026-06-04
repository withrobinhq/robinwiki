import { eq } from 'drizzle-orm'
import { makeLookupKey } from '@robin/shared'
import type { DB } from '../db/client.js'
import { edges, people } from '../db/schema.js'
import { insertExtractedPerson } from './people-settings.js'

type AuthorshipRole = 'byline' | 'quoted'

interface AuthorEdgeAttrs {
  role: AuthorshipRole
  evidence: string | null
  extractionMethod: 'deterministic' | 'llm' | 'inherited' | 'regex'
  confidence: number
}

async function insertAuthorEdge(
  db: DB,
  params: {
    srcType: 'raw_source' | 'fragment'
    srcId: string
    personKey: string
    attrs: AuthorEdgeAttrs
  }
): Promise<void> {
  const edgeType =
    params.srcType === 'raw_source' ? 'ENTRY_AUTHORED_BY_PERSON' : 'FRAGMENT_AUTHORED_BY_PERSON'
  await db
    .insert(edges)
    .values({
      id: crypto.randomUUID(),
      srcType: params.srcType,
      srcId: params.srcId,
      dstType: 'person',
      dstId: params.personKey,
      edgeType,
      attrs: params.attrs as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing()
}

async function loadOwnerPersonKey(db: DB): Promise<string | null> {
  const [row] = await db
    .select({ lookupKey: people.lookupKey })
    .from(people)
    .where(eq(people.isOwner, true))
    .limit(1)
  return row?.lookupKey ?? null
}

/**
 * Explicitly-provided authors at capture time (e.g. from MCP `authors` param).
 * Finds or creates a pending Person row for each name, then writes
 * ENTRY_AUTHORED_BY_PERSON edges. Called synchronously before the extraction
 * job is enqueued so attribution is immediate.
 */
export async function applyExplicitAuthors(
  db: DB,
  srcType: 'raw_source' | 'fragment',
  srcId: string,
  authorNames: string[]
): Promise<void> {
  for (const name of authorNames) {
    const trimmed = name.trim()
    if (!trimmed) continue

    const [existing] = await db
      .select({ lookupKey: people.lookupKey })
      .from(people)
      .where(eq(people.canonicalName, trimmed))
      .limit(1)

    const personKey = existing?.lookupKey ?? makeLookupKey('person')

    if (!existing) {
      await insertExtractedPerson(db, {
        lookupKey: personKey,
        canonicalName: trimmed,
        status: 'pending',
        createdVia: 'extractor_pending',
        extractedFromFragmentId: srcType === 'fragment' ? srcId : null,
      })
    }

    await insertAuthorEdge(db, {
      srcType,
      srcId,
      personKey,
      attrs: { role: 'byline', evidence: null, extractionMethod: 'deterministic', confidence: 1.0 },
    })
  }
}

/**
 * `thought` entries: owner is the sole author.
 * Creates ENTRY_AUTHORED_BY_PERSON + inherited FRAGMENT_AUTHORED_BY_PERSON for all fragments.
 */
export async function applyThoughtAuthorship(
  db: DB,
  entryKey: string,
  fragmentKeys: string[]
): Promise<void> {
  const ownerKey = await loadOwnerPersonKey(db)
  if (!ownerKey) return

  await insertAuthorEdge(db, {
    srcType: 'raw_source',
    srcId: entryKey,
    personKey: ownerKey,
    attrs: { role: 'byline', evidence: null, extractionMethod: 'deterministic', confidence: 1.0 },
  })

  for (const fragKey of fragmentKeys) {
    await insertAuthorEdge(db, {
      srcType: 'fragment',
      srcId: fragKey,
      personKey: ownerKey,
      attrs: { role: 'byline', evidence: null, extractionMethod: 'inherited', confidence: 1.0 },
    })
  }
}

/**
 * Parse the From: header out of raw email content.
 * Returns the best-guess display name, or null if no header found.
 */
export function parseFromHeader(content: string): string | null {
  const match = content.match(/^From:\s*(?:"?([^"<\r\n]+?)"?\s+)?<?([^>\r\n]+@[^>\r\n]+)>?/mi)
  if (!match) return null
  const name = match[1]?.trim()
  const email = match[2]?.trim()
  if (name && name.length > 0) return name
  if (email) return email.split('@')[0] ?? null
  return null
}

/**
 * `email` entries: sender from the From: header is the author.
 * Creates a pending Person row if the sender isn't already in the graph.
 */
export async function applyEmailAuthorship(
  db: DB,
  entryKey: string,
  content: string,
  fragmentKeys: string[]
): Promise<void> {
  const senderName = parseFromHeader(content)
  if (!senderName) return

  const [existing] = await db
    .select({ lookupKey: people.lookupKey })
    .from(people)
    .where(eq(people.canonicalName, senderName))
    .limit(1)

  const personKey = existing?.lookupKey ?? makeLookupKey('person')

  if (!existing) {
    await insertExtractedPerson(db, {
      lookupKey: personKey,
      canonicalName: senderName,
      status: 'pending',
      createdVia: 'extractor_pending',
      extractedFromFragmentId: null,
    })
  }

  await insertAuthorEdge(db, {
    srcType: 'raw_source',
    srcId: entryKey,
    personKey,
    attrs: { role: 'byline', evidence: null, extractionMethod: 'regex', confidence: 0.9 },
  })

  for (const fragKey of fragmentKeys) {
    await insertAuthorEdge(db, {
      srcType: 'fragment',
      srcId: fragKey,
      personKey,
      attrs: { role: 'byline', evidence: null, extractionMethod: 'inherited', confidence: 0.9 },
    })
  }
}

/**
 * `article` / `transcript` / `document` entries: Elfie-detected authorship.
 *
 * - byline mentions  → ENTRY_AUTHORED_BY_PERSON
 * - quoted mentions  → FRAGMENT_AUTHORED_BY_PERSON for the fragment whose
 *                      content contains the source span
 * - unmatched frags  → if 1 byline: inherit; if 2+ bylines: apply ALL authors;
 *                      if 0 bylines: no edges (blank is fine)
 */
export async function applyElfieAuthorship(
  db: DB,
  entryKey: string,
  authorshipMentions: Array<{ personKey: string; role: 'byline' | 'quoted'; sourceSpan: string; mention: string }>,
  fragmentContents: Array<{ key: string; content: string }>
): Promise<void> {
  if (authorshipMentions.length === 0) return

  const bylines = authorshipMentions.filter((m) => m.role === 'byline')
  const quotes = authorshipMentions.filter((m) => m.role === 'quoted')

  for (const b of bylines) {
    await insertAuthorEdge(db, {
      srcType: 'raw_source',
      srcId: entryKey,
      personKey: b.personKey,
      attrs: { role: 'byline', evidence: b.sourceSpan, extractionMethod: 'llm', confidence: 1.0 },
    })
  }

  const attributedFragKeys = new Set<string>()

  for (const q of quotes) {
    for (const frag of fragmentContents) {
      if (frag.content.includes(q.sourceSpan) || frag.content.includes(q.mention)) {
        await insertAuthorEdge(db, {
          srcType: 'fragment',
          srcId: frag.key,
          personKey: q.personKey,
          attrs: { role: 'quoted', evidence: q.sourceSpan, extractionMethod: 'llm', confidence: 1.0 },
        })
        attributedFragKeys.add(frag.key)
        break
      }
    }
  }

  for (const frag of fragmentContents) {
    if (attributedFragKeys.has(frag.key)) continue

    if (bylines.length === 1) {
      await insertAuthorEdge(db, {
        srcType: 'fragment',
        srcId: frag.key,
        personKey: bylines[0].personKey,
        attrs: { role: 'byline', evidence: null, extractionMethod: 'inherited', confidence: 1.0 },
      })
    } else if (bylines.length > 1) {
      for (const b of bylines) {
        await insertAuthorEdge(db, {
          srcType: 'fragment',
          srcId: frag.key,
          personKey: b.personKey,
          attrs: { role: 'byline', evidence: null, extractionMethod: 'inherited', confidence: 1.0 },
        })
      }
    }
  }
}

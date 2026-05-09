import { and, eq, isNull, sql } from 'drizzle-orm'
import { people, wikis, edges as edgesTable } from '../../db/schema.js'
import type { DB } from '../../db/client.js'

/**
 * Stream P (#PEOPLE-EXTRACT-Q) — relationship resolver shared by the
 * MCP create_person and update_person handlers. Each Relationship in
 * the input payload points at either a person or a wiki, identified
 * by `${kind}:<key|slug|canonical-name>`. The resolver looks the
 * target up in the right table; on a hit it writes the appropriate
 * edge type, on a miss it surfaces the unresolved entry on the
 * response so the caller can reissue once the target lands.
 */

export type RelationshipInput =
  | {
      type: 'KNOWS' | 'RELATED_TO'
      target: string // person:<key> | person:<canonical-name>
      direction?: 'bidirectional' | 'outbound'
      note?: string
      sourceFragmentId?: string
    }
  | {
      type: 'WORKS_AT' | 'AFFILIATED_WITH'
      target: string // wiki:<key> | wiki:<slug>
      role?: string
      note?: string
      sourceFragmentId?: string
    }

export interface ResolvedRelationship {
  type: RelationshipInput['type']
  target: string
  edgeId: string
  edgeType: string
}

export interface PendingRelationship {
  type: RelationshipInput['type']
  target: string
  reason: 'target-not-found' | 'invalid-format'
}

const personEdgeMap: Record<'KNOWS' | 'RELATED_TO', string> = {
  KNOWS: 'PERSON_KNOWS_PERSON',
  RELATED_TO: 'PERSON_RELATED_TO_PERSON',
}

const wikiEdgeMap: Record<'WORKS_AT' | 'AFFILIATED_WITH', string> = {
  WORKS_AT: 'PERSON_WORKS_AT_WIKI',
  AFFILIATED_WITH: 'PERSON_AFFILIATED_WITH_WIKI',
}

function parseTarget(target: string): { kind: 'person' | 'wiki'; ref: string } | null {
  const colon = target.indexOf(':')
  if (colon < 0) return null
  const kind = target.slice(0, colon)
  const ref = target.slice(colon + 1).trim()
  if (kind !== 'person' && kind !== 'wiki') return null
  if (!ref) return null
  return { kind, ref }
}

async function resolvePersonTarget(db: DB, ref: string): Promise<string | null> {
  // Exact key first.
  const [exact] = await db
    .select({ lookupKey: people.lookupKey })
    .from(people)
    .where(and(eq(people.lookupKey, ref), isNull(people.deletedAt)))
    .limit(1)
  if (exact) return exact.lookupKey

  // Canonical-name match (case-insensitive, exact text).
  const [byCanonical] = await db
    .select({ lookupKey: people.lookupKey })
    .from(people)
    .where(
      and(
        sql`lower(${people.canonicalName}) = lower(${ref})`,
        isNull(people.deletedAt)
      )
    )
    .limit(1)
  return byCanonical?.lookupKey ?? null
}

async function resolveWikiTarget(db: DB, ref: string): Promise<string | null> {
  const [exact] = await db
    .select({ lookupKey: wikis.lookupKey })
    .from(wikis)
    .where(and(eq(wikis.lookupKey, ref), isNull(wikis.deletedAt)))
    .limit(1)
  if (exact) return exact.lookupKey
  const [bySlug] = await db
    .select({ lookupKey: wikis.lookupKey })
    .from(wikis)
    .where(and(eq(wikis.slug, ref), isNull(wikis.deletedAt)))
    .limit(1)
  return bySlug?.lookupKey ?? null
}

export async function resolveAndWriteRelationship(
  db: DB,
  sourcePersonKey: string,
  rel: RelationshipInput
): Promise<{ resolved?: ResolvedRelationship; pending?: PendingRelationship }> {
  const parsed = parseTarget(rel.target)
  if (!parsed) {
    return { pending: { type: rel.type, target: rel.target, reason: 'invalid-format' } }
  }

  if (parsed.kind === 'person' && (rel.type === 'KNOWS' || rel.type === 'RELATED_TO')) {
    const targetKey = await resolvePersonTarget(db, parsed.ref)
    if (!targetKey) {
      return { pending: { type: rel.type, target: rel.target, reason: 'target-not-found' } }
    }
    const edgeId = crypto.randomUUID()
    const edgeType = personEdgeMap[rel.type]
    await db
      .insert(edgesTable)
      .values({
        id: edgeId,
        srcType: 'person',
        srcId: sourcePersonKey,
        dstType: 'person',
        dstId: targetKey,
        edgeType,
        attrs: {
          ...(rel.note ? { note: rel.note } : {}),
          ...(rel.sourceFragmentId ? { sourceFragmentId: rel.sourceFragmentId } : {}),
          ...(rel.direction ? { direction: rel.direction } : {}),
        },
      })
      .onConflictDoNothing()
    return { resolved: { type: rel.type, target: rel.target, edgeId, edgeType } }
  }

  if (
    parsed.kind === 'wiki' &&
    (rel.type === 'WORKS_AT' || rel.type === 'AFFILIATED_WITH')
  ) {
    const targetKey = await resolveWikiTarget(db, parsed.ref)
    if (!targetKey) {
      return { pending: { type: rel.type, target: rel.target, reason: 'target-not-found' } }
    }
    const edgeId = crypto.randomUUID()
    const edgeType = wikiEdgeMap[rel.type]
    await db
      .insert(edgesTable)
      .values({
        id: edgeId,
        srcType: 'person',
        srcId: sourcePersonKey,
        dstType: 'wiki',
        dstId: targetKey,
        edgeType,
        attrs: {
          ...(rel.note ? { note: rel.note } : {}),
          ...(rel.sourceFragmentId ? { sourceFragmentId: rel.sourceFragmentId } : {}),
          ...(rel.type === 'WORKS_AT' && (rel as { role?: string }).role
            ? { role: (rel as { role?: string }).role }
            : {}),
        },
      })
      .onConflictDoNothing()
    return { resolved: { type: rel.type, target: rel.target, edgeId, edgeType } }
  }

  // Mismatched kind/type combo (e.g. KNOWS pointing at a wiki).
  return { pending: { type: rel.type, target: rel.target, reason: 'invalid-format' } }
}

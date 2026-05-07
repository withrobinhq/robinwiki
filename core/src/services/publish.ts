/**
 * @module services/publish
 *
 * @summary Wiki publish/unpublish service. Single home for the
 * publish-flow logic so the HTTP route and the MCP tool both go through
 * one code path (Stream I Phase 4 / Andrew lock).
 *
 * @remarks
 * - `publishWiki` mints a fresh `publishedSlug` whenever the row is
 *   currently null (audit-M2 unpublish/republish rotation), captures the
 *   publish-time `origin` so clients can build absolute clickable URLs,
 *   sets `published = true`, preserves `publishedAt` if already set, and
 *   emits an audit row.
 * - `unpublishWiki` flips `published = false`, nulls `publishedSlug` and
 *   `publishedOrigin`, preserves `publishedAt` (history record), emits
 *   an audit row.
 * - `source` distinguishes `'api'` (HTTP) from `'mcp'` (MCP tool) so the
 *   audit log shows which surface kicked the publish.
 *
 * Errors:
 * - `'not-found'`     — wiki id doesn't exist or is soft-deleted.
 * - `'no-content'`    — `publishWiki` rejects publishing an empty wiki.
 * - Anything else propagates.
 */

import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { wikis } from '../db/schema.js'
import { nanoid24 } from '../lib/id.js'
import { emitAuditEvent } from '../db/audit.js'

export type PublishSource = 'api' | 'mcp'

export interface PublishWikiInput {
  /**
   * Origin to record on the wiki (e.g. `https://wiki.example.com`). The
   * caller resolves this from the request (`new URL(c.req.url).origin`)
   * or from `process.env.SERVER_PUBLIC_URL` for non-HTTP callers (MCP).
   * Falsy values stash null on the row -- the UI then falls back to its
   * own `window.location.origin`.
   */
  origin?: string | null
  source: PublishSource
  /**
   * Optional `source_client` snapshot (Stream I Phase 2). When set, gets
   * spread into `audit_log.detail.source_client`. Lets operators tell
   * which client pushed which publish months later.
   */
  sourceClient?: { name: string; version?: string }
}

export interface UnpublishWikiInput {
  source: PublishSource
  sourceClient?: { name: string; version?: string }
}

export type PublishResult =
  | { ok: true; wiki: typeof wikis.$inferSelect }
  | { ok: false; error: 'not-found' | 'no-content' }

/**
 * Publish a wiki. Idempotent on the slug -- mints a new one only when
 * the current row has `publishedSlug = NULL`. Audit-M2 contract.
 */
export async function publishWiki(
  db: DB,
  wikiId: string,
  input: PublishWikiInput
): Promise<PublishResult> {
  const [row] = await db.select().from(wikis).where(eq(wikis.lookupKey, wikiId))
  if (!row) return { ok: false, error: 'not-found' }
  if (!row.content) return { ok: false, error: 'no-content' }

  const slug = row.publishedSlug ?? nanoid24()
  const origin =
    typeof input.origin === 'string' && input.origin.trim().length > 0
      ? input.origin.trim()
      : null

  const [updated] = await db
    .update(wikis)
    .set({
      published: true,
      publishedSlug: slug,
      publishedAt: row.publishedAt ?? new Date(),
      publishedOrigin: origin,
      updatedAt: new Date(),
    })
    .where(eq(wikis.lookupKey, wikiId))
    .returning()

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: wikiId,
    eventType: 'published',
    source: input.source,
    summary: `Wiki published: ${row.name}`,
    detail: {
      wikiKey: wikiId,
      publishedSlug: slug,
      publishedOrigin: origin,
      ...(input.sourceClient ? { source_client: input.sourceClient } : {}),
    },
  })

  return { ok: true, wiki: updated }
}

/**
 * Unpublish a wiki. Rotates the slug (nulls it) so the next publish
 * mints a fresh URL -- defeats the user's intent if the prior link
 * gets reused. `publishedAt` is preserved (history record).
 */
export async function unpublishWiki(
  db: DB,
  wikiId: string,
  input: UnpublishWikiInput
): Promise<PublishResult> {
  const [row] = await db.select().from(wikis).where(eq(wikis.lookupKey, wikiId))
  if (!row) return { ok: false, error: 'not-found' }

  const [updated] = await db
    .update(wikis)
    .set({
      published: false,
      publishedSlug: null,
      publishedOrigin: null,
      updatedAt: new Date(),
    })
    .where(eq(wikis.lookupKey, wikiId))
    .returning()

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: wikiId,
    eventType: 'unpublished',
    source: input.source,
    summary: `Wiki unpublished: ${row.name}`,
    detail: {
      wikiKey: wikiId,
      ...(input.sourceClient ? { source_client: input.sourceClient } : {}),
    },
  })

  return { ok: true, wiki: updated }
}

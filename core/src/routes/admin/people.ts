/**
 * Stream P (#PEOPLE-EXTRACT-Q) — admin endpoints for the quarantine queue.
 *
 * Approval and rejection are intentionally HTTP-only. AI agents read the
 * queue via `list_pending_persons` (MCP) but the actual approve/reject
 * call goes through the admin UI: those are deliberate operator actions,
 * not flows we want hidden behind an MCP tool.
 *
 * Auth uses the same session middleware as `/admin/retry-stuck` and the
 * other admin endpoints; there is no separate admin token because the
 * single-tenant deployment treats the only authenticated user as the
 * operator.
 */

import { Hono } from 'hono'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { people, edges } from '../../db/schema.js'
import { sessionMiddleware } from '../../middleware/session.js'
import { logger } from '../../lib/logger.js'
import { emitAuditEvent } from '../../db/audit.js'

const log = logger.child({ component: 'admin-people' })

export const adminPeopleRoutes = new Hono()
adminPeopleRoutes.use('*', sessionMiddleware)

const listQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  since: z.string().optional(),
})

/**
 * GET /admin/people
 *
 * Triage list of persons by status. Defaults to status='pending' so the
 * admin UI can render the quarantine queue without a query string.
 */
adminPeopleRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse({
    status: c.req.query('status'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    since: c.req.query('since'),
  })
  if (!parsed.success) {
    return c.json({ error: 'invalid query', details: parsed.error.format() }, 400)
  }
  const { status, limit, offset, since } = parsed.data
  const sinceDate =
    since && !Number.isNaN(Date.parse(since)) ? new Date(since) : null

  const baseFilter = and(
    isNull(people.deletedAt),
    sql`${people.status} = ${status}`
  )
  const where = sinceDate
    ? and(baseFilter, sql`${people.createdAt} >= ${sinceDate}`)
    : baseFilter

  const rows = await db
    .select({
      lookupKey: people.lookupKey,
      slug: people.slug,
      canonicalName: people.canonicalName,
      name: people.name,
      aliases: people.aliases,
      status: people.status,
      createdAt: people.createdAt,
      createdVia: people.createdVia,
      extractedFromFragmentId: people.extractedFromFragmentId,
      relationship: people.relationship,
    })
    .from(people)
    .where(where)
    .orderBy(sql`${people.createdAt} DESC`)
    .limit(limit)
    .offset(offset)

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(people)
    .where(where)
  const total = Number(totalRows[0]?.count ?? 0)

  return c.json({
    persons: rows.map((r) => ({
      lookupKey: r.lookupKey,
      slug: r.slug,
      canonicalName: r.canonicalName,
      name: r.name,
      aliases: r.aliases ?? [],
      status: r.status,
      createdAt: r.createdAt?.toISOString?.() ?? null,
      createdVia: r.createdVia,
      extractedFromFragmentId: r.extractedFromFragmentId,
      relationship: r.relationship,
    })),
    total,
  })
})

/**
 * POST /admin/people/:lookupKey/approve
 *
 * Flips status to 'verified' and emits a 'promoted' audit row. Existing
 * FRAGMENT_MENTIONS_PERSON edges become "fully involved" with no
 * backfill — read sites carry status through, so they self-heal the
 * moment the row is verified. The wiki_agent_schema heal pass picks up
 * the new verified row on its next tick.
 */
adminPeopleRoutes.post('/:lookupKey/approve', async (c) => {
  const lookupKey = c.req.param('lookupKey')
  if (!lookupKey) return c.json({ error: 'lookupKey required' }, 400)

  const [existing] = await db
    .select({
      lookupKey: people.lookupKey,
      status: people.status,
      canonicalName: people.canonicalName,
      createdVia: people.createdVia,
    })
    .from(people)
    .where(and(eq(people.lookupKey, lookupKey), isNull(people.deletedAt)))
    .limit(1)
  if (!existing) {
    return c.json({ error: 'Person not found' }, 404)
  }
  if (existing.status === 'verified') {
    return c.json({
      lookupKey: existing.lookupKey,
      status: 'verified',
      promotedAt: null,
      alreadyVerified: true,
    })
  }

  const now = new Date()
  await db
    .update(people)
    .set({ status: 'verified', verified: true, updatedAt: now })
    .where(eq(people.lookupKey, lookupKey))

  await emitAuditEvent(db, {
    entityType: 'person',
    entityId: lookupKey,
    eventType: 'promoted',
    source: 'api',
    summary: `Person approved: ${existing.canonicalName}`,
    detail: {
      personKey: lookupKey,
      previousStatus: existing.status,
      previousCreatedVia: existing.createdVia,
    },
  })

  log.info({ lookupKey }, 'pending person approved')
  return c.json({
    lookupKey,
    status: 'verified',
    promotedAt: now.toISOString(),
  })
})

const rejectBodySchema = z.object({
  hardDelete: z.boolean().optional().default(false),
})

/**
 * POST /admin/people/:lookupKey/reject
 *
 * Default: status='rejected', edges stay attached but invisible (read
 * sites filter them out). Pass `{ hardDelete: true }` to cascade-delete
 * the row plus its edges.
 */
adminPeopleRoutes.post('/:lookupKey/reject', async (c) => {
  const lookupKey = c.req.param('lookupKey')
  if (!lookupKey) return c.json({ error: 'lookupKey required' }, 400)

  let body: z.infer<typeof rejectBodySchema> = { hardDelete: false }
  try {
    const json = await c.req.json().catch(() => ({}))
    const parsed = rejectBodySchema.safeParse(json)
    if (parsed.success) body = parsed.data
  } catch {
    // empty body is fine
  }

  const [existing] = await db
    .select({
      lookupKey: people.lookupKey,
      status: people.status,
      canonicalName: people.canonicalName,
    })
    .from(people)
    .where(and(eq(people.lookupKey, lookupKey), isNull(people.deletedAt)))
    .limit(1)
  if (!existing) {
    return c.json({ error: 'Person not found' }, 404)
  }

  if (body.hardDelete) {
    // Hard delete: cascade edges first, then the row. We do NOT rely
    // on FK ON DELETE CASCADE because the edges schema does not
    // declare it; soft-delete the rows in code instead.
    const now = new Date()
    await db
      .update(edges)
      .set({ deletedAt: now })
      .where(
        and(
          eq(edges.dstId, lookupKey),
          eq(edges.dstType, 'person'),
          isNull(edges.deletedAt)
        )
      )
    await db
      .update(people)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(people.lookupKey, lookupKey))

    await emitAuditEvent(db, {
      entityType: 'person',
      entityId: lookupKey,
      eventType: 'deleted',
      source: 'api',
      summary: `Pending person rejected and hard-deleted: ${existing.canonicalName}`,
      detail: { personKey: lookupKey, hardDelete: true, previousStatus: existing.status },
    })
    return c.json({ lookupKey, status: 'deleted' as const })
  }

  await db
    .update(people)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(eq(people.lookupKey, lookupKey))

  await emitAuditEvent(db, {
    entityType: 'person',
    entityId: lookupKey,
    eventType: 'rejected',
    source: 'api',
    summary: `Pending person rejected: ${existing.canonicalName}`,
    detail: { personKey: lookupKey, previousStatus: existing.status },
  })

  log.info({ lookupKey }, 'pending person rejected')
  return c.json({ lookupKey, status: 'rejected' as const })
})

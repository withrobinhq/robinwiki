import { Hono } from 'hono'
import { eq, sql, gte } from 'drizzle-orm'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { db } from '../db/client.js'
import { appSettings, usageEvents } from '../db/schema.js'
import { sessionMiddleware } from '../middleware/session.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'

const log = logger.child({ component: 'settings' })

export const settingsRoutes = new Hono()
settingsRoutes.use('*', sessionMiddleware)

// ── Budget caps ────────────────────────────────────────────────────────────
//
// Phase A4 — three budget caps live in app_settings: regen / embed /
// classify. Each is stored as a JSONB blob `{ "limit_usd_micros": int }`
// so the column shape is uniform across all settings (future caps can
// add fields without a schema change). Defaults pick sane low values
// for v0.2.0 dogfood; operators raise them via the spend page.

const BUDGET_KEYS = ['budget_regen', 'budget_embed', 'budget_classify'] as const
type BudgetKey = (typeof BUDGET_KEYS)[number]

// Default caps in USD micros (1e-6 USD). 5,000,000 micros = $5.00 / month.
const BUDGET_DEFAULTS: Record<BudgetKey, number> = {
  budget_regen: 10_000_000, // $10
  budget_embed: 1_000_000, // $1
  budget_classify: 5_000_000, // $5
}

interface BudgetValue {
  limit_usd_micros: number
}

const budgetSchema = z.object({
  limit_usd_micros: z.number().int().min(0).max(1_000_000_000_000),
})

async function loadBudget(key: BudgetKey): Promise<number> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1)
  if (!row) return BUDGET_DEFAULTS[key]
  const v = row.value as BudgetValue | null
  if (!v || typeof v.limit_usd_micros !== 'number') return BUDGET_DEFAULTS[key]
  return v.limit_usd_micros
}

// ── GET /settings/spend ────────────────────────────────────────────────────
//
// Returns:
//   - this-month cost rollup by stage (capture / fragment / classify / regen / embed)
//   - configured budget caps for the three caps the user can edit
//   - placeholder outstanding-work (Round 2 D-wave fragment-relationship
//     backfill cron lands later; A4 reserves the surface so the UI can
//     ship now)
settingsRoutes.get('/spend', async (c) => {
  // First day of current month (UTC) so the rollup matches a calendar
  // month boundary the user can verify against the OpenRouter ledger.
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const stageRows = (await db.execute(
    sql`SELECT stage,
               COALESCE(SUM(cost_usd_micros), 0)::bigint AS cost_usd_micros,
               COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
               COUNT(*)::int AS event_count
        FROM usage_events
        WHERE created_at >= ${monthStart.toISOString()}::timestamp
        GROUP BY stage
        ORDER BY stage`
  )) as Array<{
    stage: string
    cost_usd_micros: string | number
    total_tokens: string | number
    event_count: number
  }>

  const byStage = stageRows.map((r) => ({
    stage: r.stage,
    costUsdMicros: Number(r.cost_usd_micros),
    totalTokens: Number(r.total_tokens),
    eventCount: r.event_count,
  }))

  const totalCostUsdMicros = byStage.reduce((acc, r) => acc + r.costUsdMicros, 0)
  const totalTokens = byStage.reduce((acc, r) => acc + r.totalTokens, 0)

  const [regenBudget, embedBudget, classifyBudget] = await Promise.all([
    loadBudget('budget_regen'),
    loadBudget('budget_embed'),
    loadBudget('budget_classify'),
  ])

  return c.json({
    rangeStart: monthStart.toISOString(),
    rangeEnd: now.toISOString(),
    totalCostUsdMicros,
    totalTokens,
    byStage,
    budgets: {
      regen: { limitUsdMicros: regenBudget },
      embed: { limitUsdMicros: embedBudget },
      classify: { limitUsdMicros: classifyBudget },
    },
    // Outstanding-work placeholder. Populated by Round 2 D-wave when the
    // fragment-relationship backfill cron lands; for now the UI just
    // reserves the section.
    outstanding: {
      fragmentRelationshipBackfillQueueDepth: null,
      lastCronRunAt: null,
    },
  })
})

// ── PUT /settings/budgets/:kind ────────────────────────────────────────────
//
// Edit one of the three caps. Body: `{ "limit_usd_micros": int }`. Stored
// in app_settings under key `budget_<kind>` so the resolver can read it
// without a separate table.
settingsRoutes.put(
  '/budgets/:kind',
  zValidator('json', budgetSchema, validationHook),
  async (c) => {
    const kindParam = c.req.param('kind')
    const key = `budget_${kindParam}` as BudgetKey
    if (!BUDGET_KEYS.includes(key)) {
      return c.json({ error: 'Unknown budget kind' }, 400)
    }
    const body = c.req.valid('json')
    await db
      .insert(appSettings)
      .values({
        key,
        value: { limit_usd_micros: body.limit_usd_micros } satisfies BudgetValue,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: { limit_usd_micros: body.limit_usd_micros } satisfies BudgetValue,
          updatedAt: new Date(),
        },
      })
    log.info({ kind: kindParam, limit_usd_micros: body.limit_usd_micros }, 'budget updated')
    return c.json({
      kind: kindParam,
      limitUsdMicros: body.limit_usd_micros,
    })
  },
)

// ── GET /settings/spend/recent ─────────────────────────────────────────────
//
// Returns the last N usage_events rows (default 50, max 200) for the
// /settings/spend page's recent-activity table. Mirrors what /admin/diagnose
// surfaces but unscoped to a single entryKey.
settingsRoutes.get('/spend/recent', async (c) => {
  const rawLimit = Number(c.req.query('limit') ?? '50')
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50))
  const sinceQuery = c.req.query('since')
  // Default window: 30 days. The page's "this month" rollup is computed
  // separately; the recent-activity table just wants a wide enough
  // window that the user always sees a few rows.
  const since = sinceQuery
    ? new Date(sinceQuery)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .orderBy(sql`${usageEvents.createdAt} DESC`)
    .limit(limit)
  return c.json({
    items: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  })
})

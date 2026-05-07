import 'dotenv/config'
import { assertProdEnv } from './bootstrap/env.js'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { sessionMiddleware } from './middleware/session.js'
import { httpLogger } from './middleware/http-logger.js'
import { logger } from './lib/logger.js'
import { auth } from './auth.js'
import { entries } from './routes/entries.js'
import { search } from './routes/search.js'
import { mcp } from './routes/mcp.js'
import { users } from './routes/users.js'
import { wikisRoutes } from './routes/wikis.js'
import { groupsRoutes } from './routes/groups.js'
import { fragmentsRoutes } from './routes/fragments.js'
import { peopleRoutes } from './routes/people.js'
import { graphRoutes } from './routes/graph.js'
import { relationshipsRoutes } from './routes/relationships.js'
import { contentRoutes } from './routes/content.js'
import { wikiTypesRoutes } from './routes/wiki-types.js'
import { auditRoutes } from './routes/audit.js'
import { aiPreferencesRoutes } from './routes/ai-preferences.js'
import { aiModelsRoutes } from './routes/ai-models.js'
import { publishedRoutes } from './routes/published.js'
import { systemRoutes } from './routes/system.js'
import { startWorkers } from './queue/worker.js'
import {
  setupRegenScheduler,
  setupEmbeddingRetryScheduler,
} from './queue/scheduler.js'
import { producer } from './queue/producer.js'
import { QUEUE_NAMES } from '@robin/queue'
import { bullBoardApp } from './routes/bull-board.js'
import { adminRoutes } from './routes/admin.js'
import { authRecoverRoutes } from './routes/auth-recover.js'
import {
  checkOpenRouterKey,
  probeEmbeddingsOrRefuseWorkers,
} from './bootstrap/check-openrouter-key.js'
import { ensurePgvector } from './bootstrap/ensure-pgvector.js'
import { runMigrations } from './bootstrap/run-migrations.js'
import { seedWikiTypes } from './bootstrap/seed-wiki-types.js'
import { loadMasterKey } from './lib/crypto.js'

declare module 'hono' {
  interface ContextVariableMap {
    userId: string
    user: unknown
  }
}

/***********************************************************************
 * ## Process guards
 * Registered first so nothing escapes, even during startup.
 ***********************************************************************/

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection')
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException')
  process.exit(1)
})

process.once('SIGINT', () => process.exit(0))
process.once('SIGTERM', () => process.exit(0))

/***********************************************************************
 * ## Hono app
 ***********************************************************************/

const app = new Hono()

app.use('*', httpLogger())

// CORS policy:
//   - In production, lock to a strict allowlist built from WIKI_ORIGIN
//     (comma-separated) plus SERVER_PUBLIC_URL. Misses return null so
//     Hono omits Access-Control-Allow-Origin entirely (browser rejects).
//   - In any non-production env, reflect any caller's Origin so dev,
//     UAT, and Vercel previews can hit the API without manifest churn.
//   - assertProdEnv() above already refuses to boot in production when
//     WIKI_ORIGIN is unset, so the localhost default below is only ever
//     used in non-prod where reflect mode supersedes the allowlist anyway.
const isProd = process.env.NODE_ENV === 'production'
const allowedOrigins = new Set(
  (process.env.WIKI_ORIGIN ?? 'http://localhost:8080,http://localhost:3001')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
allowedOrigins.add(process.env.SERVER_PUBLIC_URL ?? 'http://localhost:3000')

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return null
      if (!isProd) return origin
      return allowedOrigins.has(origin) ? origin : null
    },
    credentials: true,
  }),
)

/** @step — Global error handler: catch JSON parse failures and return 400 */
app.onError((err, c) => {
  if (err instanceof SyntaxError && err.message.includes('JSON')) {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  // @hono/zod-validator wraps malformed JSON as HTTPException, not SyntaxError
  if (err.message === 'Malformed JSON in request body') {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  logger.error({ err }, 'unhandled route error')
  return c.json({ error: 'Internal server error' }, 500)
})

const openapiSpec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf-8'))
const faviconBuf = readFileSync(new URL('../assets/favicon.ico', import.meta.url))

/***********************************************************************
 * ## Pre-auth routes (+ session-gated admin)
 * Health, OpenAPI, auth recovery, published, system — no session middleware.
 * Admin and BullBoard routes apply their own session middleware.
 ***********************************************************************/

// Backend-root landing page. Users who deploy via Railway and click the
// core service's public URL thinking it's the wiki land here. Renders
// WIKI_ORIGIN as a clickable link so they can find the actual app.
// Does NOT echo INITIAL_USERNAME / INITIAL_PASSWORD — only names them.
app.get('/', (c) => {
  const rawOrigin = process.env.WIKI_ORIGIN ?? ''
  const wikiUrl = rawOrigin.split(',')[0]?.trim() ?? ''
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (ch) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
    )
  const wikiBlock = wikiUrl
    ? `<p>Your Robin wiki is at <a href="${esc(wikiUrl)}">${esc(wikiUrl)}</a>. Visit it to get started.</p>`
    : `<p>Your Robin wiki origin is not configured yet — set <code>WIKI_ORIGIN</code> in your env vars.</p>`
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Robin · Backend API</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 80px auto; padding: 0 24px; color: #222; line-height: 1.55; }
  h1 { font-weight: 600; margin: 0 0 8px; }
  .hint { color: #666; margin-top: 0; }
  a { color: #0066cc; }
  code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 0.95em; }
</style>
</head>
<body>
<h1>Hello.</h1>
<p class="hint">You've reached the Robin <strong>Backend API</strong>. This isn't where the app lives.</p>
${wikiBlock}
<p>Log in with the <code>INITIAL_USERNAME</code> and <code>INITIAL_PASSWORD</code> you set in your env vars.</p>
</body>
</html>`)
})

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))
app.get('/openapi.json', (c) => c.json(openapiSpec))
// Favicon — MCP clients (and browsers hitting the core URL directly)
// fall back to an ugly placeholder when this 404s. Adopted from
// os.withrobin.org's canonical brand asset.
app.get('/favicon.ico', (c) =>
  c.body(faviconBuf, 200, {
    'Content-Type': 'image/x-icon',
    'Cache-Control': 'public, max-age=86400',
  })
)
// M2 dormant: git-sync webhook. See import comment above.
// app.route('/internal', internalRoutes)
app.route('/admin', adminRoutes)
app.route('/auth', authRecoverRoutes)
app.route('/published', publishedRoutes)
app.route('/system', systemRoutes)
app.use('/api/auth/*', (c) => auth.handler(c.req.raw))

// BullBoard exposes queue payloads (raw user fragments), retry controls, and
// drain actions. Gated behind session auth (issue #73).
app.use('/admin/queues/*', sessionMiddleware)
app.route('/admin/queues', bullBoardApp)

/***********************************************************************
 * ## Authenticated API
 ***********************************************************************/

app.route('/entries', entries)
app.route('/search', search)
app.route('/mcp', mcp)
app.route('/users', users)
app.route('/users', aiPreferencesRoutes)
app.route('/wikis', wikisRoutes)
app.route('/groups', groupsRoutes)
app.route('/fragments', fragmentsRoutes)
app.route('/people', peopleRoutes)
app.route('/graph', graphRoutes)
app.route('/relationships', relationshipsRoutes)
app.route('/api/content', contentRoutes)
app.route('/wiki-types', wikiTypesRoutes)
app.route('/audit-log', auditRoutes)
app.route('/ai', aiModelsRoutes)

/***********************************************************************
 * ## Boot
 ***********************************************************************/

// Explicit, idempotent prod-env gate. Also runs at module load (from env.ts),
// so in practice this line is a no-op — kept here to document boot order.
assertProdEnv()

// Fail fast on missing MASTER_KEY before any crypto ops run
loadMasterKey()

// Ensure pgvector exists before migrations — some tables reference the type.
// Best-effort: logs a warning and continues if the DB role lacks CREATE EXTENSION,
// so the actual migration failure surfaces as the real error.
await ensurePgvector().catch((err) => {
  logger.warn({ err }, 'ensure-pgvector failed — continuing, migrations may fail')
})

// Apply pending migrations before any code touches the schema.
// runMigrations is idempotent and safe to call on every boot.
await runMigrations().catch((err) => {
  logger.fatal({ err }, 'run-migrations failed — refusing to start')
  process.exit(1)
})

// Warn loudly if the OpenRouter key is missing — non-fatal so non-ingest traffic still works
await checkOpenRouterKey().catch((err) => {
  logger.error({ err }, 'check-openrouter-key failed')
})

// Seed wiki types from YAML on every boot (idempotent — insert / refresh / preserve).
// Runs after migrations (needs based_on_version column) and before workers
// (workers may read wiki_types rows when regenerating wikis).
await seedWikiTypes().catch((err) => {
  logger.error({ err }, 'seed-wiki-types failed — continuing startup')
})

// Embedding reachability probe. When the OpenRouter key is configured but
// the embedding endpoint is unreachable (bad key, blocked region, outage),
// ingest workers would otherwise silently fill the DB with fragments whose
// embedding column never populates. Refuse to start workers in that case;
// HTTP server stays up so the operator can fix the config.
const embedProbe = await probeEmbeddingsOrRefuseWorkers().catch((err) => {
  logger.error({ err }, 'probe-embeddings unexpected error — continuing without gate')
  return { status: 'ok' as const }
})
if (embedProbe.status === 'unreachable') {
  logger.fatal(
    { detail: embedProbe.detail },
    'Embedding endpoint unreachable — refusing to start ingest workers. ' +
      'Check the OpenRouter API key and account allowlist / region policy ' +
      'at https://openrouter.ai/settings/privacy. HTTP server will continue ' +
      'to serve non-ingest traffic.'
  )
} else {
  if (embedProbe.status === 'no-key') {
    logger.warn(
      'Skipping embedding probe — no OPENROUTER_API_KEY. Workers starting ' +
        'anyway; per-job failures will surface as "no_openrouter_key" until ' +
        'a key is seeded.'
    )
  }
  // Single global worker — no per-user spawning under single-user M2
  startWorkers()
}

// Start the midnight regen batch scheduler (idempotent — safe on every boot)
const schedulerQueue = producer.getQueue(QUEUE_NAMES.scheduler)
await setupRegenScheduler(schedulerQueue).catch((err) => {
  logger.warn({ err }, 'regen scheduler setup failed — batch regen disabled')
})

// Embedding retry — fragments with embedding=NULL get opportunistically
// healed on a 15-min cadence. Shares the scheduler queue; the scheduler
// worker dispatches by job.type.
await setupEmbeddingRetryScheduler(schedulerQueue).catch((err) => {
  logger.warn({ err }, 'embedding retry scheduler setup failed — retries disabled')
})

const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'server started')
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.fatal(
      { port },
      `port ${port} already in use — kill the stale process or pick another port`
    )
  } else {
    logger.fatal({ err }, 'server failed to start')
  }
  process.exit(1)
})

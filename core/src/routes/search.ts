import { Hono } from 'hono'
import { db } from '../db/client.js'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { hybridSearch } from '../lib/search.js'
import { sessionMiddleware } from '../middleware/session.js'
import { resolveOrgMiddleware, checkPermissionMiddleware } from '../middleware/hooks.js'
import { searchQuerySchema, searchResponseSchema } from '../schemas/search.schema.js'

const search = new Hono()
search.use('*', sessionMiddleware)
search.use('*', resolveOrgMiddleware)
search.use('*', checkPermissionMiddleware)

// GET /search — hybrid BM25 + pgvector search across fragments, wikis, people
search.get('/', async (c) => {
  const parsed = searchQuerySchema.safeParse({
    q: c.req.query('q'),
    limit: c.req.query('limit'),
    tables: c.req.query('tables'),
    tags: c.req.query('tags'),
    mode: c.req.query('mode'),
  })
  if (!parsed.success)
    return c.json({ error: 'Validation failed', fields: parsed.error.flatten() }, 400)

  const { q, limit, tables, tags, mode } = parsed.data

  let embedConfig: { apiKey: string; model: string } | undefined
  if (mode === 'hybrid' || mode === 'vector') {
    try {
      const orConfig = await loadOpenRouterConfig()
      embedConfig = { apiKey: orConfig.apiKey, model: orConfig.models.embedding }
    } catch {
      // No OpenRouter key configured — fall back to BM25 only
    }
  }

  const results = await hybridSearch(db, q, { limit, tables, tags, mode, embedConfig })

  return c.json(searchResponseSchema.parse({ results }))
})

export { search }

import { Hono } from 'hono'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { wikis } from '../db/schema.js'
import { publicWikiResponseSchema } from '../schemas/wikis.schema.js'
import { buildSidecar } from '../lib/wikiSidecar.js'
import { makeSidecarDeps } from '../lib/wikiSidecarDeps.js'
import { stripWikiContent } from '../lib/strip-wiki-content.js'

const publishedRoutes = new Hono()

publishedRoutes.get('/wiki/:nanoid', async (c) => {
  const nanoid = c.req.param('nanoid')

  const [wiki] = await db
    .select({
      name: wikis.name,
      type: wikis.type,
      publishedAt: wikis.publishedAt,
      content: wikis.content,
      published: wikis.published,
      metadata: wikis.metadata,
      citationDeclarations: wikis.citationDeclarations,
    })
    .from(wikis)
    .where(
      and(
        eq(wikis.publishedSlug, nanoid),
        eq(wikis.published, true),
        isNull(wikis.deletedAt),
      ),
    )
    .limit(1)

  if (!wiki || !wiki.content) {
    return c.json({ error: 'Not found' }, 404)
  }

  c.header('Cache-Control', 'no-store')

  const sidecar = await buildSidecar({
    content: wiki.content,
    metadata: wiki.metadata ?? null,
    citationDeclarations: wiki.citationDeclarations ?? [],
    deps: makeSidecarDeps(db),
  })

  if (c.req.query('raw') !== undefined) {
    return c.text(stripWikiContent(wiki.content, sidecar.refs))
  }

  return c.json(
    publicWikiResponseSchema.parse({
      name: wiki.name,
      type: wiki.type,
      publishedAt: wiki.publishedAt,
      content: wiki.content,
      refs: sidecar.refs,
      infobox: sidecar.infobox,
      sections: sidecar.sections,
    })
  )
})

export { publishedRoutes }

import { z } from 'zod'
import { lookupKeySchema, objectStateSchema, paginationQuerySchema, queuedResponseSchema } from './base.schema.js'

// ── Response schemas ────────────────────────────────────────────────────────

export const personResponseSchema = z.object({
  id: lookupKeySchema,
  lookupKey: lookupKeySchema,
  slug: z.string(),
  name: z.string(),
  relationship: z.string(),
  canonicalName: z.string(),
  aliases: z.array(z.string()),
  verified: z.boolean(),
  state: objectStateSchema,
  lastRebuiltAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export const personWikiSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  type: z.string(),
  fragmentCount: z.number(),
})

/** Person detail with content and backlinks from edges table */
export const personDetailResponseSchema = personResponseSchema.extend({
  content: z.string(),
  backlinks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
    })
  ),
  wikis: z.array(personWikiSchema).default([]),
})

export const personWithBacklinksResponseSchema = personResponseSchema.extend({
  backlinkFragmentIds: z.array(z.string()),
  backlinkThreadIds: z.array(z.string()),
})

export const personListResponseSchema = z.object({
  people: z.array(personResponseSchema),
})

// ── Request schemas ─────────────────────────────────────────────────────────

export const updatePersonBodySchema = z.object({
  name: z.string().optional(),
  relationship: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  content: z.string().optional(),
})

/**
 * Manual "Add Person" — bypasses AI extraction. Manually-created persons
 * land verified=true / state=RESOLVED so they don't loiter in the
 * matcher's settlement queue. (#234)
 */
export const createPersonBodySchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).optional().default([]),
  relationship: z.string().optional().default(''),
})

/**
 * POST /people/:id/merge — repoint edges + alias union + slug rewrite +
 * soft-delete the source. (#234)
 */
export const mergePersonBodySchema = z.object({
  targetPersonId: z.string().min(1),
})

// ── Query schemas ───────────────────────────────────────────────────────────

export const personListQuerySchema = paginationQuerySchema.extend({
  offset: z.coerce.number().int().min(0).default(0),
})

export { queuedResponseSchema as personRegenerateResponseSchema }

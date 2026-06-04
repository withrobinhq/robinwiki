import { z } from 'zod'
import { lookupKeySchema, objectStateSchema, paginationQuerySchema } from './base.schema.js'

// ── Response schemas ────────────────────────────────────────────────────────

export const fragmentResponseSchema = z.object({
  id: lookupKeySchema,
  lookupKey: lookupKeySchema,
  slug: z.string(),
  title: z.string(),
  type: z.string().nullable(),
  tags: z.array(z.string()),
  confidence: z.number().nullable().optional(),
  entryId: z.string().nullable(),
  state: objectStateSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export const fragmentWithContentResponseSchema = fragmentResponseSchema.extend({
  content: z.string(),
})

/** Fragment detail with backlinks and related fragments resolved from edges table */
export const fragmentDetailResponseSchema = fragmentWithContentResponseSchema.extend({
  backlinks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
    })
  ),
  relatedFragments: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      similarity: z.number(),
    })
  ).default([]),
  authors: z.array(
    z.object({
      personKey: z.string(),
      name: z.string(),
      role: z.string(),
    })
  ).default([]),
})

export const fragmentListResponseSchema = z.object({
  fragments: z.array(fragmentResponseSchema),
})

// ── Request schemas ─────────────────────────────────────────────────────────

export const createFragmentBodySchema = z.object({
  title: z.string().min(1, 'title is required'),
  content: z.string().optional(),
  entryId: z.string().min(1, 'entryId is required'),
  tags: z.array(z.string()).default([]),
})

export const updateFragmentBodySchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

/** Body for accept/reject review endpoints */
export const fragmentReviewBodySchema = z.object({
  wikiId: z.string().min(1, 'wikiId is required'),
})

/**
 * #235 — POST /fragments/log : direct-to-wiki capture from web UI.
 * Same shape as the MCP `log_fragment` tool. Bypasses the classifier.
 */
export const logFragmentBodySchema = z.object({
  content: z.string().min(1, 'content is required'),
  threadSlug: z.string().min(1, 'threadSlug is required'),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

// ── Query schemas ───────────────────────────────────────────────────────────

export const fragmentListQuerySchema = paginationQuerySchema.extend({
  offset: z.coerce.number().int().min(0).default(0),
})

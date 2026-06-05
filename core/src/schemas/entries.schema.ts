import { z } from 'zod'
import { lookupKeySchema, objectStateSchema, paginationQuerySchema } from './base.schema.js'

// ── Response schemas ────────────────────────────────────────────────────────

export const entryResponseSchema = z.object({
  id: lookupKeySchema,
  lookupKey: lookupKeySchema,
  slug: z.string(),
  title: z.string(),
  content: z.string(),
  type: z.string(),
  source: z.string(),
  state: objectStateSchema,
  ingestStatus: z.string(),
  lastError: z.string().nullable().optional(),
  attemptCount: z.number().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  authors: z.array(
    z.object({ personKey: z.string(), name: z.string(), role: z.string() })
  ).default([]),
})

export const entryCreatedResponseSchema = entryResponseSchema.extend({
  jobId: z.string(),
  status: z.enum(['queued', 'duplicate']),
})

export const entryListResponseSchema = z.object({
  entries: z.array(entryResponseSchema),
})

// ── Request schemas ─────────────────────────────────────────────────────────

export const createEntryBodySchema = z.object({
  content: z.string().min(1, 'content is required'),
  title: z.string().optional(),
  source: z.string().default('api'),
  type: z.string().default('thought'),
})

// ── Query schemas ───────────────────────────────────────────────────────────

export const entryListQuerySchema = paginationQuerySchema

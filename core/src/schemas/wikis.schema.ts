import { z } from 'zod'
import { wikiRefsMapSchema, wikiInfoboxSchema, wikiSectionSchema } from '@robin/shared/schemas/sidecar'
import { lookupKeySchema, objectStateSchema, queuedResponseSchema } from './base.schema.js'

// ── Progress schemas ───────────────────────────────────────────────────────

export const wikiMilestoneSchema = z.object({
  label: z.string().min(1, 'milestone label must not be empty'),
  completed: z.boolean(),
})

export const wikiProgressSchema = z.object({
  milestones: z.array(wikiMilestoneSchema).min(1).max(50),
  percentage: z.number().min(0).max(100),
})

export const updateProgressBodySchema = z.object({
  milestones: z.array(wikiMilestoneSchema).min(1).max(50),
})

export const updateProgressResponseSchema = z.object({
  progress: wikiProgressSchema,
})

// ── Response schemas ────────────────────────────────────────────────────────

export const wikiCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string(),
})

export const wikiResponseSchema = z.object({
  id: lookupKeySchema,
  lookupKey: lookupKeySchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().default(''),
  type: z.string(),
  prompt: z.string(),
  state: objectStateSchema,
  lastRebuiltAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  noteCount: z.number().default(0),
  lastUpdated: z.string(),
  shortDescriptor: z.string().default(''),
  descriptor: z.string().default(''),
  progress: wikiProgressSchema.nullable().default(null),
  bouncerMode: z.enum(['auto', 'review']).default('auto'),
  published: z.boolean().default(false),
  publishedSlug: z.string().nullable().default(null),
  publishedOrigin: z.string().nullable().default(null),
  collections: z.array(wikiCollectionSchema).default([]),
})

export const wikiWithContentResponseSchema = wikiResponseSchema.extend({
  wikiContent: z.string(),
})

export const wikiDetailResponseSchema = wikiResponseSchema.extend({
  wikiContent: z.string(),
  fragments: z.array(
    z.object({
      id: lookupKeySchema,
      slug: z.string(),
      title: z.string(),
      snippet: z.string(),
      edgeStatus: z.enum(['active', 'pending']).default('active'),
    })
  ),
  people: z.array(
    z.object({
      id: lookupKeySchema,
      name: z.string(),
    })
  ),
  refs: wikiRefsMapSchema.default({}),
  infobox: wikiInfoboxSchema.nullable().default(null),
  sections: z.array(wikiSectionSchema).default([]),
})

export const wikiListResponseSchema = z.object({
  wikis: z.array(wikiResponseSchema),
})

// ── Query schemas ──────────────────────────────────────────────────────────

export const wikiListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.string().optional(),
})

// ── Request schemas ─────────────────────────────────────────────────────────

export const createWikiBodySchema = z.object({
  name: z.string().min(3, 'name must be at least 3 characters'),
  type: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
})

export const updateWikiBodySchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    prompt: z.string().optional(),
  })
  .strict()

export { queuedResponseSchema as wikiRegenerateResponseSchema }

// ── Bouncer mode schemas ──────────────────────────────────────────────────

export const bouncerModeBodySchema = z.object({
  mode: z.enum(['auto', 'review']),
})

export const bouncerModeResponseSchema = z.object({
  id: lookupKeySchema,
  bouncerMode: z.enum(['auto', 'review']),
})

// ── Publish schemas ────────────────────────────────────────────────────────

export const publishWikiResponseSchema = z.object({
  published: z.boolean(),
  publishedSlug: z.string().nullable(),
  publishedAt: z.coerce.date().nullable(),
  publishedOrigin: z.string().nullable(),
  regenerate: z.boolean(),
})

export const publicWikiResponseSchema = z.object({
  name: z.string(),
  type: z.string(),
  publishedAt: z.coerce.date(),
  content: z.string(),
  // ── Sidecar (m-wiki-sidecar) — public reads get the same structured surface ──
  refs: wikiRefsMapSchema.default({}),
  infobox: wikiInfoboxSchema.nullable().default(null),
  sections: z.array(wikiSectionSchema).default([]),
})

// ── Spawn schemas ────────────────────────────────────────────────────

export const spawnWikiBodySchema = z.object({
  name: z.string().min(3, 'name must be at least 3 characters'),
  type: z.string().optional(),
})

export const spawnWikiResponseSchema = z.object({
  lookupKey: lookupKeySchema,
  slug: z.string(),
  name: z.string(),
  type: z.string(),
  parentKey: lookupKeySchema,
  fragmentCount: z.number(),
})

// ── Regenerate toggle schemas ─────────────────────────────────────────────

export const toggleRegenerateBodySchema = z.object({
  regenerate: z.boolean(),
})

export const toggleRegenerateResponseSchema = z.object({
  id: lookupKeySchema,
  regenerate: z.boolean(),
})

// ── Edit history schemas ──────────────────────────────────────────────────

export const editRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  source: z.string(),
  contentSnippet: z.string(),
})

export const editHistoryResponseSchema = z.object({
  edits: z.array(editRecordSchema),
  total: z.number(),
})

import { z } from 'zod'

// ── Query schemas ───────────────────────────────────────────────────────────

const searchTableEnum = z.enum(['fragment', 'wiki', 'person'])
const searchModeEnum = z.enum(['hybrid', 'bm25', 'vector'])

export const searchQuerySchema = z.object({
  q: z.string().min(1, 'q is required'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  tables: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return ['fragment', 'wiki', 'person'] as const
      return v.split(',').map((s) => s.trim()) as Array<'fragment' | 'wiki' | 'person'>
    })
    .pipe(z.array(searchTableEnum).min(1)),
  // ?tags=foo,bar — UNION semantics (any-of). Mirrors `tables=`, which
  // is also a union over the row discriminator. Ignored for wiki/person
  // tables because those rows have no tags column.
  tags: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined
      const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      return parts.length > 0 ? parts : undefined
    }),
  mode: searchModeEnum.default('hybrid'),
})

// ── Response schemas ────────────────────────────────────────────────────────

export const searchResultSchema = z.object({
  id: z.string(),
  type: searchTableEnum,
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
})

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
})

/**
 * Shared sidecar Zod schemas for the wiki/entry/person read surface.
 * The milestone contract (`.planning/m-wiki-sidecar/CONTRACT.md` §3)
 * is the authoritative spec for the shapes defined here. Both the
 * core response schemas and the per-type LLM generator schemas
 * import from this file, so any shape change must land here first.
 */
import { z } from 'zod'

// ── Ref map entries ───────────────────────────────────────────────
const wikiRefBase = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),
})

export const wikiPersonRefSchema = wikiRefBase.extend({
  kind: z.literal('person'),
  relationship: z.string().optional(),
})

export const wikiFragmentRefSchema = wikiRefBase.extend({
  kind: z.literal('fragment'),
  snippet: z.string().optional(),
})

export const wikiWikiRefSchema = wikiRefBase.extend({
  kind: z.literal('wiki'),
  wikiType: z.string(),
})

export const wikiEntryRefSchema = wikiRefBase.extend({
  kind: z.literal('entry'),
  createdAt: z.string(),
})

export const wikiRefSchema = z.discriminatedUnion('kind', [
  wikiPersonRefSchema,
  wikiFragmentRefSchema,
  wikiWikiRefSchema,
  wikiEntryRefSchema,
])
export type WikiRef = z.infer<typeof wikiRefSchema>

/** Refs are keyed by `${kind}:${slug}` so lookup is direct from a token. */
export const wikiRefsMapSchema = z.record(z.string(), wikiRefSchema)

// ── Infobox ───────────────────────────────────────────────────────
export const wikiInfoboxRowSchema = z.object({
  label: z.string(),
  value: z.string(),
  valueKind: z.enum(['text', 'ref', 'date', 'status']).default('text'),
})

export const wikiInfoboxSchema = z.object({
  /**
   * STUB / NO-OP at the pipeline level (issue #160).
   *
   * The field is declared here and the client renderer (WikiInfobox)
   * handles it when present, BUT:
   *
   * - No wiki-type prompt in `packages/shared/src/prompts/specs/wiki-types/*.yaml`
   *   instructs the LLM to emit an image URL.
   * - `core/src/lib/regen.ts` and `core/src/lib/wikiSidecar.ts` never
   *   populate it.
   * - Fragment ingestion (MCP `log_entry` / `log_fragment`, HTTP entry
   *   routes) is text-only; there is no upload path for images.
   *
   * The only live consumer is the hand-written Transformer demo fixture
   * at `packages/shared/src/fixtures/wikiSidecarFixture.ts`, which uses
   * it to exercise the image branch of the renderer.
   *
   * Kept on the schema deliberately: multi-modal LLMs make image
   * emission tractable as a future phase (either via user uploads or
   * via LLM-emitted external URLs). Removing the field now would
   * require a schema + stored-metadata migration when that phase
   * ships. See issue #160 for the policy decision.
   */
  image: z.object({ url: z.string(), alt: z.string() }).optional(),
  caption: z.string().optional(),
  rows: z.array(wikiInfoboxRowSchema),
})
export type WikiInfobox = z.infer<typeof wikiInfoboxSchema>

// ── Citations (per section) ───────────────────────────────────────
export const wikiCitationSchema = z.object({
  fragmentId: z.string(),
  fragmentSlug: z.string(),
  quote: z.string().optional(),
  capturedAt: z.string(),
})
export type WikiCitation = z.infer<typeof wikiCitationSchema>

// ── Section ───────────────────────────────────────────────────────
export const wikiSectionSchema = z.object({
  /** Slugified heading. Stable across regenerations so URL fragments survive. */
  id: z.string(),
  /** Mirror of `id`; exposed for callers that want to build `#anchor` URLs. */
  anchor: z.string(),
  heading: z.string(),
  level: z.number().int().min(1).max(6),
  citations: z.array(wikiCitationSchema).default([]),
})
export type WikiSection = z.infer<typeof wikiSectionSchema>

// ── Metadata column shape ─────────────────────────────────────────
/**
 * Shape of the `wikis.metadata` JSONB column. `infobox` may be null if
 * the generator did not emit one; additional structured sidecar fields
 * will be added here over time.
 */
export const wikiMetadataSchema = z.object({
  infobox: wikiInfoboxSchema.nullable().default(null),
})
export type WikiMetadata = z.infer<typeof wikiMetadataSchema>

// ── LLM generator-side: citation declaration ──────────────────────
/**
 * Emitted by the per-type LLM generator. Pairs a slugified section
 * anchor with the fragment ids the model relied on when writing it.
 */
export const wikiCitationDeclarationSchema = z.object({
  sectionAnchor: z.string(),
  fragmentIds: z.array(z.string()).min(1),
})
export type WikiCitationDeclaration = z.infer<typeof wikiCitationDeclarationSchema>

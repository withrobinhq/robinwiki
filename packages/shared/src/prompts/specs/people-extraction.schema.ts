import { z } from 'zod'

/**
 * v3 (Stream P, 2026-05-09): Elfie surfaces every person-like mention,
 * split into two buckets. Matched entries point to a verified KNOWN
 * PEOPLE row by key. Candidate entries are person-like mentions that
 * had no match; the worker handles dedup against pending persons and
 * creation downstream.
 *
 * The legacy `people` flat array (v2 shape with matchedKey: string|null)
 * is preserved as an OPTIONAL passthrough for any caller still on the
 * old contract (notably the entity-extract test fixtures). Consumers
 * should read from `matched` and `candidates`; the synthetic `people`
 * passthrough is filled in by code on top of the schema, not the
 * schema itself, to keep input and output types matching.
 */
const authorshipRoleSchema = z.enum(['byline', 'quoted', 'mentioned']).optional()

const matchedMentionSchema = z.object({
  mention: z.string(),
  inferredName: z.string(),
  matchedKey: z.string(),
  confidence: z.number(),
  sourceSpan: z.string(),
  authorshipRole: authorshipRoleSchema,
})

const candidateMentionSchema = z.object({
  mention: z.string(),
  inferredName: z.string(),
  confidence: z.number(),
  sourceSpan: z.string(),
  authorshipRole: authorshipRoleSchema,
})

const legacyMentionSchema = z.object({
  mention: z.string(),
  inferredName: z.string(),
  matchedKey: z.string().nullable(),
  confidence: z.number(),
  sourceSpan: z.string(),
})

// Both buckets are required at the schema level so consumer code can
// rely on `parsed.matched` / `parsed.candidates` always being arrays.
// The LLM is told to return both buckets in every payload (see the
// people-extraction.yaml template). For legacy v2 fixtures that hand
// us a flat `people` array we keep an optional passthrough; consumers
// normalise via `normalisePeopleExtraction`.
export const peopleExtractionSchema = z.object({
  matched: z.array(matchedMentionSchema),
  candidates: z.array(candidateMentionSchema),
  people: z.array(legacyMentionSchema).optional(),
})

export type PeopleExtractionOutput = z.infer<typeof peopleExtractionSchema>
export type MatchedMention = z.infer<typeof matchedMentionSchema>
export type CandidateMention = z.infer<typeof candidateMentionSchema>
export type LegacyMention = z.infer<typeof legacyMentionSchema>

/**
 * Normalise a parsed PeopleExtractionOutput into the canonical bucket
 * shape. Reads the new `matched`/`candidates` buckets when present and
 * also splits any legacy `people` entries by `matchedKey` nullability.
 * Use this from any consumer that needs the canonical buckets.
 */
export function normalisePeopleExtraction(
  parsed: PeopleExtractionOutput
): { matched: MatchedMention[]; candidates: CandidateMention[] } {
  // Defensive copies that tolerate mocked LLM payloads which only
  // hand us the legacy `people` field. Real Zod-parsed payloads
  // always carry `matched` and `candidates` arrays.
  const matched: MatchedMention[] = parsed.matched ? [...parsed.matched] : []
  const candidates: CandidateMention[] = parsed.candidates ? [...parsed.candidates] : []
  if (parsed.people && parsed.people.length > 0) {
    for (const p of parsed.people) {
      if (p.matchedKey !== null) {
        matched.push({
          mention: p.mention,
          inferredName: p.inferredName,
          matchedKey: p.matchedKey,
          confidence: p.confidence,
          sourceSpan: p.sourceSpan,
        })
      } else {
        candidates.push({
          mention: p.mention,
          inferredName: p.inferredName,
          confidence: p.confidence,
          sourceSpan: p.sourceSpan,
        })
      }
    }
  }
  return { matched, candidates }
}

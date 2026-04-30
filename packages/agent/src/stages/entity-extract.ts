import * as fuzz from 'fuzzball'
import { loadPeopleExtractionSpec } from '@robin/shared'
import type {
  EntityExtractDeps,
  EntityExtractResult,
  KnownPerson,
  ResolutionConfig,
  StageResult,
} from './types.js'

// ── Resolution ──────────────────────────────────────────────────────────────

interface Extraction {
  mention: string
  inferredName: string
  matchedKey?: string | null
}

export interface ResolveResult {
  personKey: string
  isNew: boolean
  newAlias?: string
  isUpgrade?: boolean
  upgradedCanonicalName?: string
}

/**
 * Resolve a single person mention against known people using weighted fuzzy matching.
 * Pure function -- no side effects, independently testable.
 */
export function resolvePerson(
  extraction: Extraction,
  knownPeople: KnownPerson[],
  config: ResolutionConfig,
  makePeopleKey: () => string
): ResolveResult {
  const { mention } = extraction

  if (knownPeople.length === 0) {
    return { personKey: makePeopleKey(), isNew: true }
  }

  // Score each known person
  type Scored = { person: KnownPerson; weightedScore: number; rawScore: number }
  const scored: Scored[] = knownPeople.map((person) => {
    const canonicalRaw = fuzz.token_set_ratio(mention, person.canonicalName)
    const aliasScores = person.aliases.map((a) => ({
      raw: fuzz.token_set_ratio(mention, a),
      weighted: fuzz.token_set_ratio(mention, a) * config.aliasWeight,
    }))

    const canonicalWeighted = canonicalRaw * config.canonicalWeight
    const bestAlias =
      aliasScores.length > 0
        ? aliasScores.reduce((best, cur) => (cur.weighted > best.weighted ? cur : best))
        : null

    const weightedScore = Math.max(canonicalWeighted, bestAlias?.weighted ?? 0)
    const rawScore = Math.max(
      canonicalRaw,
      ...person.aliases.map((a) => fuzz.token_set_ratio(mention, a))
    )

    return { person, weightedScore, rawScore }
  })

  // Sort descending by weighted score
  scored.sort((a, b) => b.weightedScore - a.weightedScore)

  const top = scored[0]

  // Score floor check on raw (unweighted) score
  if (top.rawScore < config.scoreFloor) {
    return { personKey: makePeopleKey(), isNew: true }
  }

  // Ambiguity check: if second candidate is too close
  if (scored.length > 1) {
    const second = scored[1]
    if (
      second.weightedScore > 0 &&
      top.weightedScore / second.weightedScore < config.ratioThreshold
    ) {
      return { personKey: makePeopleKey(), isNew: true }
    }
  }

  // Match found
  const matched = top.person

  // Check if mention is a new alias (case-insensitive dedup)
  const mentionLower = mention.toLowerCase()
  const isCanonical = matched.canonicalName.toLowerCase() === mentionLower
  const isKnownAlias = matched.aliases.some((a) => a.toLowerCase() === mentionLower)
  const newAlias = !isCanonical && !isKnownAlias ? mention : undefined

  // Auto-upgrade: if matched person has "(unnamed)" in canonical and mention is a real name
  const isUnnamed = matched.canonicalName.includes('(unnamed)')
  const mentionIsRealName = !mention.includes('(unnamed)')
  if (isUnnamed && mentionIsRealName) {
    return {
      personKey: matched.lookupKey,
      isNew: false,
      newAlias,
      isUpgrade: true,
      upgradedCanonicalName: mention,
    }
  }

  return {
    personKey: matched.lookupKey,
    isNew: false,
    newAlias,
  }
}

// ── Entity Extract Stage ────────────────────────────────────────────────────

interface EntityExtractInput {
  content: string
  entryKey: string
  jobId: string
}

export async function entityExtract(
  deps: EntityExtractDeps,
  input: EntityExtractInput
): Promise<StageResult<EntityExtractResult>> {
  const start = Date.now()

  await deps.emitEvent({
    entryKey: input.entryKey,
    jobId: input.jobId,
    stage: 'entity-extract',
    status: 'started',
  })

  // 1. Load known people
  const knownPeople = await deps.loadAllPeople()

  // 2. Build known people JSON for prompt
  const knownPeopleJson =
    knownPeople.length > 0
      ? JSON.stringify(
          knownPeople.map((p) => ({
            key: p.lookupKey,
            canonicalName: p.canonicalName,
            aliases: p.aliases,
          }))
        )
      : undefined

  // 3. Load prompt spec
  const spec = loadPeopleExtractionSpec({
    content: input.content,
    knownPeople: knownPeopleJson,
  })

  // 4. Call LLM (returns Zod-validated output)
  const parsed = await deps.llmCall(spec.system, spec.user)

  // 6. Resolve each extraction. #237: Elfie is matcher-only — unmatched
  // mentions are DROPPED instead of becoming new Person rows. The
  // resolvePerson() helper is still the score-based matcher; when it
  // reports `isNew: true` we treat that as a "no match" signal and
  // skip the mention entirely. Authorship for first-person pronouns is
  // handled downstream by the classifier's [AUTHORSHIP] block (#238),
  // not here.
  const peopleMap = new Map<string, string>()
  const newAliases = new Map<string, string[]>()
  const newPeople: EntityExtractResult['newPeople'] = []
  let unmatchedDropped = 0

  for (const extraction of parsed.people) {
    const resolved = resolvePerson(extraction, knownPeople, deps.config, deps.makePeopleKey)

    if (resolved.isNew) {
      // No matching Person row — drop this mention. Do NOT add it to
      // peopleMap (which would seed a FRAGMENT_MENTIONS_PERSON edge to
      // a non-existent person) and do NOT push it onto newPeople
      // (which would have persist.ts upsert a Person on its behalf).
      unmatchedDropped++
      continue
    }

    peopleMap.set(extraction.mention, resolved.personKey)

    if (resolved.newAlias) {
      const existing = newAliases.get(resolved.personKey) ?? []
      existing.push(resolved.newAlias)
      newAliases.set(resolved.personKey, existing)
    }
  }

  await deps.emitEvent({
    entryKey: input.entryKey,
    jobId: input.jobId,
    stage: 'entity-extract',
    status: 'completed',
    metadata: {
      totalMentions: parsed.people.length,
      matchedMentions: peopleMap.size,
      unmatchedDropped,
      newPeople: newPeople.length,
    },
  })

  return {
    data: {
      peopleMap,
      newAliases,
      // Filter extractions down to those that matched so persist's
      // mention-to-fragment edge logic can't re-introduce a dropped
      // mention. Unmatched mentions never reach persist.
      extractions: parsed.people.filter((e) => peopleMap.has(e.mention)),
      newPeople,
    },
    durationMs: Date.now() - start,
  }
}

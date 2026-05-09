import * as fuzz from 'fuzzball'
import { loadPeopleExtractionSpec, normalisePeopleExtraction } from '@robin/shared'
import { resolveOrDrop } from '../people/resolveOrDrop.js'
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
    stage: 'classify',
    status: 'started',
    metadata: { substage: 'entity-extract' },
  })

  // 1. Load known people (verified + optionally pending for dedup)
  const verifiedPeople = await deps.loadAllPeople()
  const pendingPeople = deps.loadPendingPeople ? await deps.loadPendingPeople() : []

  // 2. Build known people JSON for prompt (verified only — pending
  //    persons are not graph-visible to the LLM yet).
  const knownPeopleJson =
    verifiedPeople.length > 0
      ? JSON.stringify(
          verifiedPeople.map((p) => ({
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

  // 4. Call LLM (returns Zod-validated output, accepts both v3 buckets
  //    and the legacy v2 flat array).
  const parsed = await deps.llmCall(spec.system, spec.user)
  const buckets = normalisePeopleExtraction(parsed)
  const rawMentionsSeen = buckets.matched.length + buckets.candidates.length

  // 5. Resolve every mention through the shared helper. Worker pipeline
  //    and MCP `log_fragment` both call this — same input, same outcome.
  const autoAccept = deps.loadAutoAcceptPersons
    ? await deps.loadAutoAcceptPersons()
    : false

  // Backward-compat path: if no insertPerson dep was wired, the legacy
  // pipeline still routes new persons through `persist.ts` via the
  // `newPeople[]` array. We mark them as pending in that case so the
  // upsertPerson code path can apply the right status.
  const newPeople: EntityExtractResult['newPeople'] = []
  const peopleMap = new Map<string, string>()
  const newAliases = new Map<string, string[]>()
  const matchedExtractions: EntityExtractResult['extractions'] = []
  let unmatchedDropped = 0
  let createdPersons = 0

  const insertPerson =
    deps.insertPerson ??
    (async (input) => {
      // Legacy persist-driven path: the helper ran (and assigned a
      // lookupKey) but we route the row through `newPeople[]` so the
      // existing persist stage's `upsertPerson` can de-dup against
      // canonical_name (case-insensitive).
      newPeople.push({
        personKey: input.lookupKey,
        canonicalName: input.canonicalName,
        verified: input.status === 'verified',
        status: input.status,
      })
    })

  const outcomes = await resolveOrDrop(
    {
      matched: buckets.matched,
      candidates: buckets.candidates,
    },
    {
      // Worker pipeline does not have a fragment id yet at extract
      // time (fragments persist later in the same run). Pass null and
      // let the persist stage backfill the linkage via FRAGMENT_MENTIONS_PERSON.
      fragmentId: null,
      autoAccept,
      verifiedPeople,
      pendingPeople,
      makePersonKey: deps.makePeopleKey,
      insertPerson,
      resolutionConfig: deps.config,
    }
  )

  for (const outcome of outcomes) {
    if (outcome.kind === 'dropped') {
      unmatchedDropped++
      continue
    }
    if (outcome.kind === 'created_pending' || outcome.kind === 'created_verified') {
      createdPersons++
    }
    peopleMap.set(outcome.mention, outcome.lookupKey)
    // H2 (#329): confidence is only present on `matched`/`pending`
    // outcomes (the LLM reported a score for those buckets).
    // `created_pending`/`created_verified` come from the candidate
    // bucket where the matcher synthesised a row, so we record 1.0
    // for newly minted persons (the row exists because we believed
    // the candidate, full stop).
    const confidence =
      outcome.kind === 'matched' || outcome.kind === 'pending'
        ? outcome.confidence
        : 1
    matchedExtractions.push({
      mention: outcome.mention,
      sourceSpan: outcome.sourceSpan.text,
      confidence,
    })
  }

  // Alias merging: matched + pending + verified outcomes whose mention
  // surface form differs from the canonical name should be appended as
  // aliases on the existing row. This preserves the v2 newAliases
  // behaviour for downstream merging in the persist stage.
  for (const outcome of outcomes) {
    if (outcome.kind !== 'matched' && outcome.kind !== 'pending') continue
    const known = [...verifiedPeople, ...pendingPeople].find(
      (p) => p.lookupKey === outcome.lookupKey
    )
    if (!known) continue
    const lower = outcome.mention.toLowerCase()
    const isCanonical = known.canonicalName.toLowerCase() === lower
    const isKnownAlias = known.aliases.some((a) => a.toLowerCase() === lower)
    if (isCanonical || isKnownAlias) continue
    const list = newAliases.get(outcome.lookupKey) ?? []
    if (!list.some((a) => a.toLowerCase() === lower)) {
      list.push(outcome.mention)
      newAliases.set(outcome.lookupKey, list)
    }
  }

  const denominator = rawMentionsSeen
  const dropRatePct =
    denominator > 0
      ? Math.round(((denominator - peopleMap.size - createdPersons) / denominator) * 100)
      : 0

  await deps.emitEvent({
    entryKey: input.entryKey,
    jobId: input.jobId,
    stage: 'classify',
    status: 'completed',
    metadata: {
      substage: 'entity-extract',
      // Stream P telemetry. `rawMentionsSeen` is what the LLM surfaced
      // (matched + candidates). `dropRatePct` is the share of those
      // mentions that did not become a graph edge (resolver
      // disagreement only — created pending/verified count as kept).
      rawMentionsSeen,
      matchedMentions: peopleMap.size,
      createdPersons,
      unmatchedDropped,
      dropRatePct,
      autoAccept,
      newPeople: newPeople.length,
    },
  })

  return {
    data: {
      peopleMap,
      newAliases,
      extractions: matchedExtractions,
      newPeople,
    },
    durationMs: Date.now() - start,
  }
}

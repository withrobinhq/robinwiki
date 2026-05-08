import {
  makeLookupKey,
  generateSlug,
  applyFragmentTitleDatePrefix,
} from '@robin/shared'
import type { StageResult, PersistDeps, PersistResult, FragmentResult } from './types.js'
import { embedText } from '../embeddings.js'

/**
 * Match mention extractions to fragments by checking if the extraction's
 * sourceSpan or mention text appears in each fragment's content or sourceSpan.
 * Returns Map<fragmentIndex, personKeys[]> with deduplication.
 */
export function matchMentionsToFragments(
  extractions: Array<{ mention: string; sourceSpan: string }>,
  fragments: FragmentResult[],
  peopleMap: Map<string, string>
): Map<number, string[]> {
  const result = new Map<number, string[]>()

  for (const extraction of extractions) {
    const personKey = peopleMap.get(extraction.mention)
    if (!personKey) continue

    for (let i = 0; i < fragments.length; i++) {
      const frag = fragments[i]
      const haystack = `${frag.content}\n${frag.sourceSpan}`

      const matched =
        haystack.includes(extraction.sourceSpan) || haystack.includes(extraction.mention)

      if (matched) {
        const existing = result.get(i) ?? []
        if (!existing.includes(personKey)) {
          existing.push(personKey)
          result.set(i, existing)
        }
      }
    }
  }

  return result
}

/**
 * Persist stage — pure Postgres.
 * Inserts entry, fragments (with embeddings), people (upserted by canonical_name),
 * and all edges. No markdown assembly, no git writes.
 */
export async function persist(
  deps: PersistDeps,
  input: {
    entryKey: string
    entryContent: string
    source: string
    fragments: FragmentResult[]
    primaryTopic: string
    jobId: string
    peopleMap?: Map<string, string>
    newAliases?: Map<string, string[]>
    extractions?: Array<{ mention: string; sourceSpan: string }>
    newPeople?: Array<{ personKey: string; canonicalName: string; verified: boolean }>
    entityExtractionStatus?: 'completed' | 'failed'
  }
): Promise<StageResult<PersistResult>> {
  const start = performance.now()

  // Resolve per-fragment person matches
  const fragmentPersonKeys =
    input.extractions && input.peopleMap && input.peopleMap.size > 0
      ? matchMentionsToFragments(input.extractions, input.fragments, input.peopleMap)
      : new Map<number, string[]>()

  // -- Entry insert --
  const entrySlug = generateSlug(input.primaryTopic)
  await deps.insertEntry({
    lookupKey: input.entryKey,
    slug: entrySlug,
    title: input.primaryTopic,
    content: input.entryContent,
    source: input.source,
    state: 'PENDING',
  })

  // -- Fragment inserts --
  // #239 — every fragment created by the worker pipeline gets a UTC
  // YYMMDD prefix on its title. The helper is a no-op when the LLM
  // already emitted a date-shaped prefix.
  const fragmentKeys: string[] = input.fragments.map(() => makeLookupKey('frag'))
  for (let i = 0; i < input.fragments.length; i++) {
    const frag = input.fragments[i]
    const prefixedTitle = applyFragmentTitleDatePrefix(frag.title)
    await deps.insertFragment({
      lookupKey: fragmentKeys[i],
      slug: frag.suggestedSlug || generateSlug(prefixedTitle),
      title: prefixedTitle,
      content: frag.content,
      type: frag.type,
      entryId: input.entryKey,
      tags: frag.tags,
      state: 'PENDING',
      confidence: frag.confidence,
    })
  }

  // -- Fragment embeddings (best-effort, parallel) --
  const embedConfig = {
    apiKey: deps.openRouterConfig.apiKey,
    model: deps.openRouterConfig.models.embedding,
  }
  const vectors = await Promise.all(
    input.fragments.map(async (frag, i) => {
      const t0 = performance.now()
      const vec = await embedText(frag.content, embedConfig)
      const durationMs = Math.round(performance.now() - t0)
      if (deps.onEmbedUsage) {
        try {
          await deps.onEmbedUsage({
            fragmentKey: fragmentKeys[i],
            inputChars: frag.content.length,
            durationMs,
            success: vec !== null,
          })
        } catch {
          // Cost-logging must not block the persist path.
        }
      }
      return vec
    })
  )
  await Promise.all(
    vectors.map((vec, i) =>
      vec ? deps.updateFragmentEmbedding(fragmentKeys[i], vec) : Promise.resolve()
    )
  )

  // -- Person upserts for new people --
  const personKeyRemap = new Map<string, string>()
  if (input.newPeople && input.newPeople.length > 0) {
    for (const person of input.newPeople) {
      const { personKey, isNew } = await deps.upsertPerson({
        personKey: person.personKey,
        canonicalName: person.canonicalName,
        verified: person.verified,
      })
      if (personKey !== person.personKey) {
        personKeyRemap.set(person.personKey, personKey)
      }
      if (isNew && deps.onPersonCreated) {
        deps.onPersonCreated(personKey, person.canonicalName)
      }
    }
  }

  // -- Merge aliases into existing people --
  if (input.newAliases && input.newAliases.size > 0) {
    for (const [personKey, aliases] of input.newAliases.entries()) {
      const resolved = personKeyRemap.get(personKey) ?? personKey
      await deps.mergePersonAliases(resolved, aliases)
    }
  }

  // -- Edges: ENTRY_HAS_FRAGMENT --
  for (const fragKey of fragmentKeys) {
    await deps.insertEdge({
      srcType: 'entry',
      srcId: input.entryKey,
      dstType: 'fragment',
      dstId: fragKey,
      edgeType: 'ENTRY_HAS_FRAGMENT',
    })
  }

  // -- Edges: FRAGMENT_MENTIONS_PERSON --
  for (const [fragIdx, personKeys] of fragmentPersonKeys.entries()) {
    const fragKey = fragmentKeys[fragIdx]
    for (const personKey of personKeys) {
      const resolved = personKeyRemap.get(personKey) ?? personKey
      await deps.insertEdge({
        srcType: 'fragment',
        srcId: fragKey,
        dstType: 'person',
        dstId: resolved,
        edgeType: 'FRAGMENT_MENTIONS_PERSON',
      })
    }
  }

  await deps.emitEvent({
    entryKey: input.entryKey,
    jobId: input.jobId,
    stage: 'capture',
    status: 'completed',
    metadata: {
      substage: 'persist',
      fragmentCount: fragmentKeys.length,
      personCount: input.newPeople?.length ?? 0,
    },
  })

  return {
    data: { entryKey: input.entryKey, fragmentKeys },
    durationMs: performance.now() - start,
  }
}

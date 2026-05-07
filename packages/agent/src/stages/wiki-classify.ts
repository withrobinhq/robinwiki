import { loadWikiClassificationSpec } from '@robin/shared'
import type { StageResult, WikiClassifyDeps, WikiClassifyResult } from './types.js'

const THRESHOLD = Number(process.env.WIKI_CLASSIFY_THRESHOLD) || 0.65

/**
 * Wiki classification stage.
 * Finds top-10 candidate wikis via hybrid search, loads their metadata,
 * then sends all candidates in a single batch LLM call. In greenfield (no
 * existing wikis) this returns an empty wikiEdges array without failing.
 */
export async function wikiClassify(
  deps: WikiClassifyDeps,
  input: {
    fragmentContent: string
    fragmentKey: string
    jobId: string
    entryKey: string
  }
): Promise<StageResult<WikiClassifyResult>> {
  const start = performance.now()

  const candidates = await deps.searchCandidates(input.fragmentContent, 10)

  if (candidates.length === 0) {
    await deps.emitEvent({
      entryKey: input.entryKey,
      jobId: input.jobId,
      stage: 'classify',
      status: 'completed',
      fragmentKey: input.fragmentKey,
      metadata: {
        substage: 'wiki-classify',
        candidateCount: 0,
        matchedCount: 0,
        threshold: THRESHOLD,
      },
    })
    return { data: { wikiEdges: [] }, durationMs: performance.now() - start }
  }

  const wikiKeys = candidates.map((c) => c.wikiKey)
  const wikis = await deps.loadThreads(wikiKeys)

  const wikisJson = JSON.stringify(
    wikis.map((t) => ({
      key: t.lookupKey,
      name: t.name,
      wikiType: t.type,
      description: t.description ?? '',
    }))
  )

  const ownerName = deps.loadOwnerName ? ((await deps.loadOwnerName()) ?? undefined) : undefined

  const spec = loadWikiClassificationSpec({
    content: input.fragmentContent,
    wikis: wikisJson,
    ownerName,
  })
  const result = await deps.llmCall(spec.system, spec.user)

  const wikiEdges = result.assignments
    .filter((a) => a.confidence >= THRESHOLD)
    .map((a) => ({ wikiKey: a.wikiKey, score: a.confidence }))

  await deps.emitEvent({
    entryKey: input.entryKey,
    jobId: input.jobId,
    stage: 'classify',
    status: 'completed',
    fragmentKey: input.fragmentKey,
    metadata: {
      substage: 'wiki-classify',
      candidateCount: candidates.length,
      matchedCount: wikiEdges.length,
      threshold: THRESHOLD,
    },
  })

  return {
    data: {
      wikiEdges,
      rawAssignments: result.assignments.map((a) => ({
        wikiKey: a.wikiKey,
        confidence: a.confidence,
        reasoning: a.reasoning,
      })),
    },
    durationMs: performance.now() - start,
  }
}

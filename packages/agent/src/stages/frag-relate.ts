import { loadFragmentRelevanceSpec } from '@robin/shared'
import type { StageResult, FragRelateDeps, FragRelateResult } from './types.js'

const THRESHOLD = Number(process.env.FRAG_RELATE_THRESHOLD) || 0.5

/**
 * Fragment-to-fragment relationship stage.
 * Uses vector-only search for top-5 candidates, loads each candidate's content,
 * then LLM-scores each with the dedicated fragment-relevance prompt.
 * Bidirectional edge creation is the orchestrator's responsibility.
 */
export async function fragRelate(
  deps: FragRelateDeps,
  input: {
    fragmentContent: string
    fragmentKey: string
    jobId: string
    entryKey: string
  }
): Promise<StageResult<FragRelateResult>> {
  const start = performance.now()

  const candidates = await deps.vectorSearch(input.fragmentContent, 5)
  const filtered = candidates.filter((c) => c.fragmentKey !== input.fragmentKey)

  const relatedEdges: Array<{ fragmentKey: string; score: number }> = []
  for (const candidate of filtered) {
    const content = await deps.loadFragmentContent(candidate.fragmentKey)
    if (!content) continue

    const spec = loadFragmentRelevanceSpec({
      sourceContent: input.fragmentContent,
      candidateContent: content,
    })
    const result = await deps.llmCall(spec.system, spec.user)

    if (result.score >= THRESHOLD) {
      relatedEdges.push({ fragmentKey: candidate.fragmentKey, score: result.score })
    }
  }

  await deps.emitEvent({
    entryKey: input.entryKey,
    jobId: input.jobId,
    stage: 'classify',
    status: 'completed',
    fragmentKey: input.fragmentKey,
    metadata: {
      substage: 'frag-relate',
      candidateCount: filtered.length,
      scoredCount: relatedEdges.length,
    },
  })

  return {
    data: { relatedEdges },
    durationMs: performance.now() - start,
  }
}

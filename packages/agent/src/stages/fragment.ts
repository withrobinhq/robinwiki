import { loadFragmentationSpec, computeFragmentLimits } from '@robin/shared'
import { dedupBatch } from '../dedup.js'
import type { StageResult, FragmentDeps, FragmentResult } from './types.js'

const DEDUP_THRESHOLD = Number(process.env.DEDUP_THRESHOLD) || 0.6

/**
 * Fragmentation stage.
 * Splits entry content into typed fragments via LLM, then runs intra-batch
 * Jaccard dedup and soft size validation.
 */
export async function fragment(
  deps: FragmentDeps,
  input: { content: string; entryKey: string; jobId: string }
): Promise<StageResult<{ fragments: FragmentResult[]; primaryTopic: string }>> {
  const start = performance.now()

  const spec = loadFragmentationSpec({ content: input.content })
  const parsed = await deps.llmCall(spec.system, spec.user)

  // Intra-batch Jaccard dedup
  const deduped = dedupBatch(parsed.fragments, DEDUP_THRESHOLD)

  // Hard ceiling: keep top N by confidence to prevent over-splitting
  const contentWords = input.content.split(/\s+/).filter(Boolean).length
  const { ceiling } = computeFragmentLimits(contentWords)
  const capped =
    deduped.length > ceiling
      ? deduped.sort((a, b) => b.confidence - a.confidence).slice(0, ceiling)
      : deduped

  // Soft size validation -- warn but accept all fragments
  for (const frag of capped) {
    const wordCount = frag.content.split(/\s+/).length
    if (wordCount > 200) {
      await deps.emitEvent({
        entryKey: input.entryKey,
        jobId: input.jobId,
        stage: 'fragment',
        status: 'completed',
        metadata: {
          substage: 'fragmentation',
          warning: 'fragment_size_out_of_range',
          wordCount,
          fragmentTitle: frag.title,
        },
      })
    }
  }

  return {
    data: { fragments: capped, primaryTopic: parsed.primaryTopic },
    durationMs: performance.now() - start,
  }
}

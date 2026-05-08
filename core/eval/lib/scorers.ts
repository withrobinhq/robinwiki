import type { FragmentationFixture, ClassificationFixture } from './fixture-loader.js'

/**
 * Custom scorers for Robin's eval suites.
 *
 * The fragmentation scorer rewards three behaviours independently:
 *   1. Count is inside the expected window.
 *   2. Every "must-contain" claim shows up in at least one fragment.
 *   3. No "must-not-contain" filler leaks into the fragment set.
 *
 * Each behaviour contributes equally to the 0..1 score so a regression in
 * any one dimension is visible. Scores are pure-function — no LLM judge
 * needed for these structural assertions. Autoevals' `Factuality` is the
 * right tool for semantic fidelity once the corpus is rich enough.
 */
export function fragmentationShapeScorer(args: {
  output: { fragments: Array<{ content: string }> }
  expected: FragmentationFixture
}): { name: string; score: number; metadata: Record<string, unknown> } {
  const { output, expected } = args
  const count = output.fragments.length
  const countOk =
    count >= expected.expectedCount.min && count <= expected.expectedCount.max

  const haystack = output.fragments.map((f) => f.content.toLowerCase()).join('\n')
  const containsHits = expected.mustContain.filter((claim) =>
    haystack.includes(claim.toLowerCase()),
  )
  const containsScore = expected.mustContain.length
    ? containsHits.length / expected.mustContain.length
    : 1

  const fluff = expected.mustNotContain ?? []
  const fluffMisses = fluff.filter((phrase) => haystack.includes(phrase.toLowerCase()))
  const fluffScore = fluff.length ? 1 - fluffMisses.length / fluff.length : 1

  const score = ((countOk ? 1 : 0) + containsScore + fluffScore) / 3

  return {
    name: 'fragmentation_shape',
    score,
    metadata: {
      count,
      expectedCountWindow: expected.expectedCount,
      countOk,
      containsHits,
      containsMissing: expected.mustContain.filter((c) => !containsHits.includes(c)),
      fluffMisses,
    },
  }
}

/**
 * Classification scorer: macro-F1-style. Computes precision (no wrong wikis)
 * and recall (every expected wiki landed) per fixture, returns the harmonic
 * mean. Forbidden wikis count as precision-zero hits when present.
 */
export function classificationLandingScorer(args: {
  output: { wikis: string[] }
  expected: ClassificationFixture
}): { name: string; score: number; metadata: Record<string, unknown> } {
  const { output, expected } = args
  const got = new Set(output.wikis)
  const want = new Set(expected.expected)
  const forbid = new Set(expected.forbidden ?? [])

  const truePositives = [...got].filter((w) => want.has(w))
  const falsePositives = [...got].filter((w) => !want.has(w))
  const falseNegatives = [...want].filter((w) => !got.has(w))
  const forbiddenHits = [...got].filter((w) => forbid.has(w))

  const precision =
    got.size === 0 ? 1 : truePositives.length / got.size
  const recall =
    want.size === 0 ? 1 : truePositives.length / want.size
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  // Forbidden wikis are a hard penalty: collapse the score if any landed.
  const score = forbiddenHits.length > 0 ? 0 : f1

  return {
    name: 'classification_landing',
    score,
    metadata: {
      precision,
      recall,
      truePositives,
      falsePositives,
      falseNegatives,
      forbiddenHits,
    },
  }
}

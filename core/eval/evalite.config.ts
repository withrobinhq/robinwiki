import { defineConfig } from 'evalite/config'

/**
 * Evalite config for Robin's fragmentation + classification eval suites.
 *
 * Threshold is intentionally permissive (50) until Phyl has reviewed the
 * corpora — once the baselines settle, raise this. The CI workflow can use
 * the same config; PR runs override `setupFiles` to scope the corpus.
 */
export default defineConfig({
  scoreThreshold: 50,
  testTimeout: 60_000,
  maxConcurrency: 4,
})

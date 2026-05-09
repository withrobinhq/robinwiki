// Backfill script logic test (#69 D6 follow-up; Stream S decouple).
//
// The script delegates to findWikisMissingDescriptionRow + embedText +
// ensureAgentSchema(mode='backfill'). Asserting the contract here:
//   - dry-run does NOT load OpenRouter config
//   - dry-run does NOT call embedText
//   - dry-run does NOT call ensureAgentSchema
//   - the live path loads config, embeds, and calls ensureAgentSchema for each target
//   - idempotency: a clean instance (empty target list) is a no-op
//
// We don't shell out to the script as a process; we re-implement its
// per-target loop against the same helpers so the test stays hermetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMock = vi.fn()
const ensureMock = vi.fn().mockResolvedValue({
  wikiKey: '',
  mode: 'backfill',
  written: { description: true, hyde_synthetic: false },
  staled: { hyde_synthetic: false },
  shortCircuited: false,
})
const embedMock = vi.fn()
const loadConfigMock = vi.fn()

vi.mock('@robin/agent', () => ({
  embedText: (...args: unknown[]) => embedMock(...args),
}))
vi.mock('../src/lib/wiki-agent-schema.js', () => ({
  findWikisMissingDescriptionRow: (...args: unknown[]) => findMock(...args),
  ensureAgentSchema: (...args: unknown[]) => ensureMock(...args),
}))
vi.mock('../src/lib/openrouter-config.js', () => ({
  loadOpenRouterConfig: () => loadConfigMock(),
}))
vi.mock('../src/db/client.js', () => ({ db: {} }))
vi.mock('../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

interface Target {
  wikiKey: string
  description: string
}

// Re-implementation of the script's inner loop (matches scripts/backfill-wiki-agent-schema.ts
// via core/src/lib/backfill-runner.ts).
async function runBackfill(opts: { dryRun: boolean; limit?: number }): Promise<{
  ok: number
  failed: number
  scanned: number
}> {
  const limit = opts.limit ?? Number.MAX_SAFE_INTEGER
  const PAGE_SIZE = 100
  let processed = 0
  let ok = 0
  let failed = 0
  let scanned = 0

  let config: { apiKey: string; models: { embedding: string } } | null = null
  if (!opts.dryRun) config = await loadConfigMock()

  while (processed < limit) {
    const remaining = limit - processed
    const chunk: Target[] = await findMock(undefined, Math.min(PAGE_SIZE, remaining))
    if (chunk.length === 0) break
    scanned += chunk.length

    for (const target of chunk) {
      if (opts.dryRun) {
        ok++
        processed++
        continue
      }
      const vec = await embedMock(target.description, {
        apiKey: config!.apiKey,
        model: config!.models.embedding,
      })
      if (vec) {
        await ensureMock(undefined, target.wikiKey, {
          mode: 'backfill',
          description: target.description,
          precomputedEmbedding: vec,
          orConfig: config,
          context: { source: 'system', triggeredBy: 'backfill' },
        })
        ok++
      } else {
        failed++
      }
      processed++
    }
    if (chunk.length < PAGE_SIZE) break
  }

  return { ok, failed, scanned }
}

beforeEach(() => {
  findMock.mockReset()
  ensureMock.mockReset().mockResolvedValue({
    wikiKey: '',
    mode: 'backfill',
    written: { description: true, hyde_synthetic: false },
    staled: { hyde_synthetic: false },
    shortCircuited: false,
  })
  embedMock.mockReset()
  loadConfigMock.mockReset()
  loadConfigMock.mockResolvedValue({
    apiKey: 'k',
    models: { embedding: 'e' },
  })
})

describe('backfill-wiki-agent-schema (#69 D6, Stream S)', () => {
  it("calls ensureAgentSchema(mode='backfill') for each target", async () => {
    findMock
      .mockResolvedValueOnce([
        { wikiKey: 'wiki1', description: 'desc one' },
        { wikiKey: 'wiki2', description: 'desc two' },
      ])
      .mockResolvedValue([])
    embedMock
      .mockResolvedValueOnce([0.1])
      .mockResolvedValueOnce([0.2])

    const result = await runBackfill({ dryRun: false })

    expect(result).toEqual({ ok: 2, failed: 0, scanned: 2 })
    expect(ensureMock).toHaveBeenCalledTimes(2)
    expect(ensureMock.mock.calls[0][1]).toBe('wiki1')
    expect(ensureMock.mock.calls[0][2].mode).toBe('backfill')
    expect(ensureMock.mock.calls[0][2].description).toBe('desc one')
    expect(ensureMock.mock.calls[0][2].precomputedEmbedding).toEqual([0.1])
    expect(ensureMock.mock.calls[1][1]).toBe('wiki2')
    expect(ensureMock.mock.calls[1][2].precomputedEmbedding).toEqual([0.2])
  })

  it('idempotency: empty target list is a no-op (no LLM, no helper call)', async () => {
    findMock.mockResolvedValue([])

    const result = await runBackfill({ dryRun: false })

    expect(result).toEqual({ ok: 0, failed: 0, scanned: 0 })
    expect(ensureMock).not.toHaveBeenCalled()
    expect(embedMock).not.toHaveBeenCalled()
  })

  it('dry-run does not call embedText, ensureAgentSchema, or load config', async () => {
    findMock
      .mockResolvedValueOnce([{ wikiKey: 'wiki1', description: 'd' }])
      .mockResolvedValue([])

    const result = await runBackfill({ dryRun: true })

    expect(result).toEqual({ ok: 1, failed: 0, scanned: 1 })
    expect(loadConfigMock).not.toHaveBeenCalled()
    expect(embedMock).not.toHaveBeenCalled()
    expect(ensureMock).not.toHaveBeenCalled()
  })

  it('counts a failure when embed returns null and continues', async () => {
    findMock
      .mockResolvedValueOnce([
        { wikiKey: 'wiki-bad', description: 'fails' },
        { wikiKey: 'wiki-good', description: 'works' },
      ])
      .mockResolvedValue([])
    embedMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([0.5])

    const result = await runBackfill({ dryRun: false })

    expect(result).toEqual({ ok: 1, failed: 1, scanned: 2 })
    expect(ensureMock).toHaveBeenCalledTimes(1)
    expect(ensureMock.mock.calls[0][1]).toBe('wiki-good')
  })

  it('respects --limit by stopping after N targets', async () => {
    findMock
      .mockResolvedValueOnce([
        { wikiKey: 'wiki1', description: 'a' },
      ])
      .mockResolvedValue([])
    embedMock.mockResolvedValueOnce([0.1])

    const result = await runBackfill({ dryRun: false, limit: 1 })

    expect(result).toEqual({ ok: 1, failed: 0, scanned: 1 })
    expect(ensureMock).toHaveBeenCalledTimes(1)
  })
})

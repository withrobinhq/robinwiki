import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────────

// Drizzle-style chain stub for db.select(...).from(...).where(...).limit(...)
// and db.select(...).from(...).limit(...) — both forms used by checkOpenRouterKey.
//
// Each call to db.select returns a fresh chain that resolves to the next entry
// in `selectReturns`. Tests push the row arrays they want returned in order.
const selectReturns: Array<Array<Record<string, unknown>>> = []

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(selectReturns.shift() ?? []),
        }),
        limit: () =>
          Promise.resolve(selectReturns.shift() ?? []),
      }),
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  configs: {
    id: 'id',
    kind: 'kind',
    key: 'key',
  },
  users: {
    id: 'id',
  },
}))

const setConfigMock = vi.fn()
vi.mock('../../lib/config.js', () => ({
  setConfig: (...args: unknown[]) => setConfigMock(...args),
}))

// `loadOpenRouterConfig` is unused by checkOpenRouterKey but the module imports
// it for the sibling `probeEmbeddingsOrRefuseWorkers`. Provide a stub so the
// import graph resolves without booting the real config.
vi.mock('../../lib/openrouter-config.js', () => ({
  loadOpenRouterConfig: vi.fn(),
}))

vi.mock('@robin/agent', () => ({
  NoOpenRouterKeyError: class NoOpenRouterKeyError extends Error {},
  probeEmbeddingReachable: vi.fn(),
}))

const validateMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
vi.mock('../../lib/validate-openrouter-key.js', () => ({
  validateOpenRouterKey: (...args: unknown[]) => validateMock(...args),
}))

const logInfoMock = vi.fn()
const logWarnMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: (...args: unknown[]) => logInfoMock(...args),
      warn: (...args: unknown[]) => logWarnMock(...args),
      error: (...args: unknown[]) => logErrorMock(...args),
      debug: vi.fn(),
    }),
  },
}))

// ── Import under test (after mocks) ────────────────────────────────────────

const { checkOpenRouterKey } = await import('../check-openrouter-key.js')

// ── Tests ───────────────────────────────────────────────────────────────────

describe('checkOpenRouterKey', () => {
  const originalEnv = process.env.OPENROUTER_API_KEY

  beforeEach(() => {
    selectReturns.length = 0
    setConfigMock.mockReset()
    logInfoMock.mockReset()
    logWarnMock.mockReset()
    logErrorMock.mockReset()
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENROUTER_API_KEY
    } else {
      process.env.OPENROUTER_API_KEY = originalEnv
    }
  })

  it('auto-seeds when env var set + no row + user exists', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test'
    // First select: configs lookup returns no rows.
    selectReturns.push([])
    // Second select: users lookup returns one user.
    selectReturns.push([{ id: 'user-123' }])
    setConfigMock.mockResolvedValue(undefined)

    await checkOpenRouterKey()

    expect(setConfigMock).toHaveBeenCalledTimes(1)
    expect(setConfigMock).toHaveBeenCalledWith({
      scope: 'user',
      userId: 'user-123',
      kind: 'llm_key',
      key: 'openrouter',
      value: 'sk-or-v1-test',
      encrypted: true,
    })
    expect(logInfoMock).toHaveBeenCalledWith(
      { userId: 'user-123' },
      'openrouter key auto-seeded from OPENROUTER_API_KEY env var',
    )
  })

  it('does not seed when row already exists', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test'
    selectReturns.push([{ id: 'config-1' }])

    await checkOpenRouterKey()

    expect(setConfigMock).not.toHaveBeenCalled()
    expect(logInfoMock).toHaveBeenCalledWith('openrouter key present in configs')
  })

  it('does not seed when env var unset + no row', async () => {
    delete process.env.OPENROUTER_API_KEY
    selectReturns.push([])

    await checkOpenRouterKey()

    expect(setConfigMock).not.toHaveBeenCalled()
    expect(logWarnMock).toHaveBeenCalledTimes(1)
    expect(logWarnMock.mock.calls[0]?.[0]).toMatch(
      /OPENROUTER_API_KEY env var unset/,
    )
  })

  it('does not seed when env var set + no user yet', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test'
    selectReturns.push([]) // configs: empty
    selectReturns.push([]) // users: empty

    await checkOpenRouterKey()

    expect(setConfigMock).not.toHaveBeenCalled()
    expect(logWarnMock).toHaveBeenCalledTimes(1)
    expect(logWarnMock.mock.calls[0]?.[0]).toMatch(/retry on next boot/)
  })

  it('logs error but does not throw when setConfig fails', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test'
    selectReturns.push([]) // configs: empty
    selectReturns.push([{ id: 'user-123' }]) // users: present
    const failure = new Error('encryption blew up')
    setConfigMock.mockRejectedValue(failure)

    await expect(checkOpenRouterKey()).resolves.toBeUndefined()

    expect(logErrorMock).toHaveBeenCalledTimes(1)
    expect(logErrorMock.mock.calls[0]?.[0]).toEqual({ err: failure })
    expect(logErrorMock.mock.calls[0]?.[1]).toMatch(
      /auto-seed of openrouter key failed/,
    )
  })
})

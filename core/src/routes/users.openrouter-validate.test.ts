import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// ── Mocks (must come before dynamic import) ────────────────────────────────

const mockValidate = vi.fn()

vi.mock('../db/client.js', () => ({ db: {} }))
vi.mock('../db/audit.js', () => ({ emitAuditEvent: vi.fn() }))
vi.mock('../lib/config.js', () => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
}))
vi.mock('../lib/validate-openrouter-key.js', () => ({
  validateOpenRouterKey: (...args: unknown[]) => mockValidate(...args),
}))
vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'test-user')
    await next()
  }),
}))
vi.mock('../keypair.js', () => ({ decryptPrivateKey: vi.fn() }))
vi.mock('../mcp/jwt.js', () => ({
  signMcpToken: vi.fn().mockResolvedValue('mock-token'),
  clearKidCache: vi.fn(),
}))

const { users } = await import('./users.js')

function post(path: string, body?: unknown) {
  return users.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('POST /users/openrouter-key/validate', () => {
  const originalEnv = process.env.OPENROUTER_API_KEY

  beforeEach(() => {
    mockValidate.mockReset()
    delete process.env.OPENROUTER_API_KEY
  })

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalEnv
  })

  it('returns ok:true when validator succeeds (explicit body key)', async () => {
    mockValidate.mockResolvedValue({ ok: true, status: 200 })
    const res = await post('/openrouter-key/validate', { key: 'sk-or-v1-good' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockValidate).toHaveBeenCalledWith('sk-or-v1-good')
  })

  it('returns Invalid API key on 401', async () => {
    mockValidate.mockResolvedValue({ ok: false, status: 401, error: 'Invalid API key' })
    const res = await post('/openrouter-key/validate', { key: 'sk-or-v1-bad' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, error: 'Invalid API key' })
  })

  it('returns generic error for non-401 failures (no leak)', async () => {
    mockValidate.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'OpenRouter returned 500: rate limit token=abc',
    })
    const res = await post('/openrouter-key/validate', { key: 'sk-or-v1-good' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Could not reach OpenRouter')
    expect(JSON.stringify(body)).not.toContain('token=abc')
  })

  it('falls back to env var when body has no key', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-fromenv'
    mockValidate.mockResolvedValue({ ok: true, status: 200 })
    const res = await post('/openrouter-key/validate', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockValidate).toHaveBeenCalledWith('sk-or-v1-fromenv')
  })

  it('returns ok:false with no-key error when nothing is configured', async () => {
    const res = await post('/openrouter-key/validate', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'No OpenRouter key configured',
    })
    expect(mockValidate).not.toHaveBeenCalled()
  })
})

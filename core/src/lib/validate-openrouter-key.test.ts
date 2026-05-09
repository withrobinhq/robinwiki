import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateOpenRouterKey } from './validate-openrouter-key.js'

describe('validateOpenRouterKey', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns ok:false for empty key without calling fetch', async () => {
    const result = await validateOpenRouterKey('')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/empty or too short/)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns ok:false for too-short key without calling fetch', async () => {
    const result = await validateOpenRouterKey('abc')
    expect(result.ok).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns ok:true on 200', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 200 }),
    )
    const result = await validateOpenRouterKey('sk-or-v1-validkey')
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('returns ok:false with Invalid API key on 401', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{"error":"unauthorized"}', { status: 401 }),
    )
    const result = await validateOpenRouterKey('sk-or-v1-invalid')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe('Invalid API key')
  })

  it('returns ok:false with generic error on 500', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('boom', { status: 500 }),
    )
    const result = await validateOpenRouterKey('sk-or-v1-validkey')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.error).toMatch(/OpenRouter returned 500/)
  })

  it('returns ok:false on network error', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNRESET'),
    )
    const result = await validateOpenRouterKey('sk-or-v1-validkey')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Network or timeout: ECONNRESET/)
  })
})

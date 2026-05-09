/**
 * Validate an OpenRouter API key by calling GET /api/v1/models.
 * 200 means the key is accepted; 401 means invalid.
 *
 * Uses a 5s timeout so a network blip doesn't block onboarding forever.
 */
export interface OpenRouterValidationResult {
  ok: boolean
  status?: number
  error?: string
}

export async function validateOpenRouterKey(
  key: string,
  signal?: AbortSignal,
): Promise<OpenRouterValidationResult> {
  if (!key || key.length < 10) {
    return { ok: false, error: 'Key is empty or too short' }
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5_000)
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: signal ?? ctrl.signal,
    })
    clearTimeout(timer)
    if (res.ok) return { ok: true, status: res.status }
    if (res.status === 401) return { ok: false, status: 401, error: 'Invalid API key' }
    return { ok: false, status: res.status, error: `OpenRouter returned ${res.status}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Network or timeout: ${msg}` }
  }
}

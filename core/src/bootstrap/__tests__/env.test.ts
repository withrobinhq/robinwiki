import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Required env vars must be present before the env module is first imported,
// otherwise `createConfigVar` calls `process.exit(1)` at module load time.
const baseProdlikeEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/robin_test',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'a'.repeat(40),
  MASTER_KEY: 'a'.repeat(64),
  KEY_ENCRYPTION_SECRET: 'b'.repeat(40),
  INITIAL_USERNAME: 'admin@example.com',
  INITIAL_PASSWORD: 'password123',
  OPENROUTER_API_KEY: 'sk-test',
  SERVER_PUBLIC_URL: 'https://api.example.com',
  WIKI_ORIGIN: 'https://wiki.example.com',
}
for (const [k, v] of Object.entries(baseProdlikeEnv)) {
  process.env[k] = v
}

// Import the helper after env is populated so the module doesn't blow up on load.
const { normalizeOrigin } = await import('../env.js')

describe('normalizeOrigin', () => {
  it('prepends https:// to bare hostnames', () => {
    expect(normalizeOrigin('api.example.com')).toBe('https://api.example.com')
  })

  it('preserves https:// URLs unchanged', () => {
    expect(normalizeOrigin('https://api.example.com')).toBe('https://api.example.com')
  })

  it('preserves http:// URLs unchanged (local dev)', () => {
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(normalizeOrigin('  api.example.com  ')).toBe('https://api.example.com')
    expect(normalizeOrigin('  https://api.example.com  ')).toBe('https://api.example.com')
  })

  it('treats existing scheme prefixes case-insensitively', () => {
    expect(normalizeOrigin('HTTPS://api.example.com')).toBe('HTTPS://api.example.com')
  })
})

// Each scenario re-imports `../env.js` after mutating process.env so we
// observe a fresh schema parse + post-parse mutation.
async function loadEnvModule(envOverrides: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  return import('../env.js')
}

describe('env module post-parse normalization', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      delete process.env[k]
    }
    Object.assign(process.env, originalEnv)
    vi.resetModules()
  })

  it('normalizes bare-hostname SERVER_PUBLIC_URL to https://', async () => {
    await loadEnvModule({
      ...baseProdlikeEnv,
      SERVER_PUBLIC_URL: 'api.example.com',
      WIKI_ORIGIN: 'https://wiki.example.com',
    })
    expect(process.env.SERVER_PUBLIC_URL).toBe('https://api.example.com')
  })

  it('leaves already-prefixed https SERVER_PUBLIC_URL unchanged', async () => {
    await loadEnvModule({
      ...baseProdlikeEnv,
      SERVER_PUBLIC_URL: 'https://api.example.com',
      WIKI_ORIGIN: 'https://wiki.example.com',
    })
    expect(process.env.SERVER_PUBLIC_URL).toBe('https://api.example.com')
  })

  it('preserves http:// SERVER_PUBLIC_URL for local dev', async () => {
    await loadEnvModule({
      ...baseProdlikeEnv,
      SERVER_PUBLIC_URL: 'http://localhost:3000',
      WIKI_ORIGIN: 'http://localhost:8080',
    })
    expect(process.env.SERVER_PUBLIC_URL).toBe('http://localhost:3000')
  })

  it('normalizes bare-hostname WIKI_ORIGIN to https://', async () => {
    await loadEnvModule({
      ...baseProdlikeEnv,
      SERVER_PUBLIC_URL: 'https://api.example.com',
      WIKI_ORIGIN: 'wiki.example.com',
    })
    expect(process.env.WIKI_ORIGIN).toBe('https://wiki.example.com')
  })

  it('normalizes mixed comma-separated WIKI_ORIGIN entries', async () => {
    await loadEnvModule({
      ...baseProdlikeEnv,
      SERVER_PUBLIC_URL: 'https://api.example.com',
      WIKI_ORIGIN: 'https://wiki.example.com,custom.example.com',
    })
    expect(process.env.WIKI_ORIGIN).toBe(
      'https://wiki.example.com,https://custom.example.com',
    )
  })

  it('preserves http:// entries while normalizing bare ones in WIKI_ORIGIN', async () => {
    await loadEnvModule({
      ...baseProdlikeEnv,
      SERVER_PUBLIC_URL: 'https://api.example.com',
      WIKI_ORIGIN: 'https://wiki.example.com,http://localhost:8080',
    })
    expect(process.env.WIKI_ORIGIN).toBe(
      'https://wiki.example.com,http://localhost:8080',
    )
  })

  it('trims whitespace around comma-separated WIKI_ORIGIN entries', async () => {
    await loadEnvModule({
      ...baseProdlikeEnv,
      SERVER_PUBLIC_URL: 'https://api.example.com',
      WIKI_ORIGIN: '  https://wiki.example.com ,  custom.example.com  ',
    })
    expect(process.env.WIKI_ORIGIN).toBe(
      'https://wiki.example.com,https://custom.example.com',
    )
  })

  it('rejects garbage SERVER_PUBLIC_URL even after normalization', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => {
        throw new Error('process.exit called')
      }) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      loadEnvModule({
        ...baseProdlikeEnv,
        SERVER_PUBLIC_URL: 'not a url at all',
        WIKI_ORIGIN: 'https://wiki.example.com',
      }),
    ).rejects.toThrow('process.exit called')

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('rejects empty WIKI_ORIGIN entries from a stray comma', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => {
        throw new Error('process.exit called')
      }) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      loadEnvModule({
        ...baseProdlikeEnv,
        SERVER_PUBLIC_URL: 'https://api.example.com',
        WIKI_ORIGIN: 'https://wiki.example.com,',
      }),
    ).rejects.toThrow('process.exit called')

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

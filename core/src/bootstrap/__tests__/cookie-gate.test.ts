import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SEC-H2 boot gate. assertProdEnv() must:
 *   - throw (process.exit) when NODE_ENV=production and SERVER_PUBLIC_URL is
 *     missing or http://
 *   - succeed when NODE_ENV=production and SERVER_PUBLIC_URL is https://
 *   - succeed in dev (NODE_ENV != production) regardless of URL scheme
 */

const originalEnv = { ...process.env }

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
})

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, originalEnv)
  vi.resetModules()
})

async function loadAssert(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // Importing env.ts runs assertProdEnv() at module load. Use the named
  // export too so we can call it again deterministically.
  const mod = await import('../env.js')
  return mod
}

describe('assertProdEnv — SEC-H2 cookie gate', () => {
  it('throws in production when SERVER_PUBLIC_URL is http://', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      loadAssert({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/robin',
        REDIS_URL: 'redis://localhost:6379',
        BETTER_AUTH_SECRET: 'a'.repeat(40),
        RECOVERY_SECRET: 'b'.repeat(40),
        MASTER_KEY: 'a'.repeat(64),
        KEY_ENCRYPTION_SECRET: 'c'.repeat(40),
        JOB_SIGNING_SECRET: 'd'.repeat(40),
        INITIAL_USERNAME: 'admin@example.com',
        INITIAL_PASSWORD: 'password123',
        OPENROUTER_API_KEY: 'sk-test',
        SERVER_PUBLIC_URL: 'http://api.example.com',
        WIKI_ORIGIN: 'https://wiki.example.com',
      }),
    ).rejects.toThrow('process.exit called')

    const calls = errorSpy.mock.calls.map((args) => args.join(' '))
    expect(calls.some((m) => m.includes('SERVER_PUBLIC_URL must start with https://'))).toBe(true)

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('passes in production when SERVER_PUBLIC_URL is https://', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)

    await expect(
      loadAssert({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/robin',
        REDIS_URL: 'redis://localhost:6379',
        BETTER_AUTH_SECRET: 'a'.repeat(40),
        RECOVERY_SECRET: 'b'.repeat(40),
        MASTER_KEY: 'a'.repeat(64),
        KEY_ENCRYPTION_SECRET: 'c'.repeat(40),
        JOB_SIGNING_SECRET: 'd'.repeat(40),
        INITIAL_USERNAME: 'admin@example.com',
        INITIAL_PASSWORD: 'password123',
        OPENROUTER_API_KEY: 'sk-test',
        SERVER_PUBLIC_URL: 'https://api.example.com',
        WIKI_ORIGIN: 'https://wiki.example.com',
      }),
    ).resolves.toBeTruthy()

    expect(exitSpy).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })

  it('passes in development with http://localhost SERVER_PUBLIC_URL', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)

    await expect(
      loadAssert({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://localhost/robin',
        REDIS_URL: 'redis://localhost:6379',
        BETTER_AUTH_SECRET: 'a'.repeat(40),
        MASTER_KEY: 'a'.repeat(64),
        KEY_ENCRYPTION_SECRET: 'c'.repeat(40),
        INITIAL_USERNAME: 'admin@example.com',
        INITIAL_PASSWORD: 'password123',
        OPENROUTER_API_KEY: 'sk-test',
        SERVER_PUBLIC_URL: 'http://localhost:3000',
        WIKI_ORIGIN: 'http://localhost:8080',
      }),
    ).resolves.toBeTruthy()

    expect(exitSpy).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })
})

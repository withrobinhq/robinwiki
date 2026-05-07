import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validEnvStub } from '../../__tests__/helpers/validEnvStub.js'

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
      loadAssert(validEnvStub({ SERVER_PUBLIC_URL: 'http://api.example.com' })),
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

    await expect(loadAssert(validEnvStub())).resolves.toBeTruthy()

    expect(exitSpy).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })

  it('passes in development with http://localhost SERVER_PUBLIC_URL', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)

    await expect(
      loadAssert(
        validEnvStub({
          NODE_ENV: 'development',
          SERVER_PUBLIC_URL: 'http://localhost:3000',
          WIKI_ORIGIN: 'http://localhost:8080',
          // assertProdEnv is a no-op outside production; RECOVERY_SECRET and
          // JOB_SIGNING_SECRET are optional in the Zod schema, so drop them
          // here to mirror the original dev-mode env shape.
          RECOVERY_SECRET: undefined,
          JOB_SIGNING_SECRET: undefined,
        }),
      ),
    ).resolves.toBeTruthy()

    expect(exitSpy).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })
})

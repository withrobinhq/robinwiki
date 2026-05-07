import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validEnvStub } from '../../__tests__/helpers/validEnvStub.js'

/**
 * SEC-H2 boot gate. assertProdEnv() must:
 *   - throw `ProdSafetyError` when NODE_ENV=production and SERVER_PUBLIC_URL
 *     is missing or http://
 *   - succeed when NODE_ENV=production and SERVER_PUBLIC_URL is https://
 *   - succeed in dev (NODE_ENV != production) regardless of URL scheme
 *
 * Phase 6 / Plan 04 refactored assertProdEnv to throw `ProdSafetyError`
 * instead of calling `process.exit(1)` so the `assertProdSafety` aggregator
 * can collect every failure into a single boot-time error message.
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
  return import('../env.js')
}

describe('assertProdEnv — SEC-H2 cookie gate', () => {
  it('throws in production when SERVER_PUBLIC_URL is http://', async () => {
    const mod = await loadAssert(validEnvStub({ SERVER_PUBLIC_URL: 'http://api.example.com' }))

    expect(() => mod.assertProdEnv()).toThrow(mod.ProdSafetyError)
    expect(() => mod.assertProdEnv()).toThrow(/SERVER_PUBLIC_URL must start with https:\/\//)
  })

  it('passes in production when SERVER_PUBLIC_URL is https://', async () => {
    const mod = await loadAssert(validEnvStub())

    expect(() => mod.assertProdEnv()).not.toThrow()
  })

  it('passes in development with http://localhost SERVER_PUBLIC_URL', async () => {
    const mod = await loadAssert(
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
    )

    expect(() => mod.assertProdEnv()).not.toThrow()
  })
})

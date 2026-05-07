/**
 * Minimum env that satisfies `assertProdEnv` in NODE_ENV=production.
 *
 * Tests that exercise downstream boot gates (cookie security, https url,
 * recovery, etc.) should spread this BEFORE per-test overrides so the
 * required-vars check passes and the gate under test is the one that runs.
 *
 * Single source of truth: when `bootstrap/env.ts` adds a new required var,
 * update this file once instead of sweeping every env-stubbing test.
 *
 * Returns a plain `Record<string, string>` rather than mutating `process.env`
 * so callers stay in control of their own env lifecycle (the existing tests
 * snapshot+wipe `process.env` per case and don't want a helper layering on
 * `vi.stubEnv` cleanup semantics on top of that).
 *
 * Example:
 *   Object.assign(process.env, validEnvStub({ SERVER_PUBLIC_URL: 'http://x' }))
 */
export function validEnvStub(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const baseline: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://localhost/robin',
    REDIS_URL: 'redis://localhost:6379',
    BETTER_AUTH_SECRET: 'a'.repeat(40),
    MASTER_KEY: 'a'.repeat(64),
    KEY_ENCRYPTION_SECRET: 'c'.repeat(40),
    WIKI_ORIGIN: 'https://wiki.example.com',
    JOB_SIGNING_SECRET: 'd'.repeat(40),
    RECOVERY_SECRET: 'b'.repeat(40),
    SERVER_PUBLIC_URL: 'https://api.example.com',
    // Not in assertProdEnv's required[] but the Zod schema in env.ts validates
    // these whenever the module loads in production — include them so dynamic
    // `await import('../bootstrap/env.js')` inside tests doesn't crash on the
    // schema parse step before reaching the boot gate under test.
    INITIAL_USERNAME: 'admin@example.com',
    INITIAL_PASSWORD: 'password123',
    OPENROUTER_API_KEY: 'sk-test',
  }
  const merged: Record<string, string> = { ...baseline }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  return merged
}

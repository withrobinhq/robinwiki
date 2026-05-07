import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeypair } from '../keypair.js'

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// We use the real keypair + jose stack so signMcpToken and verifyMcpToken
// exercise their actual signing paths. Only the DB and logger are mocked:
// `db.select(...)` is replaced with a function that returns either the
// user list (cache rebuild path) or a single-row read (signMcpToken's
// initial load and verifyMcpToken's freshness check).

const SECRET = 'test-encryption-secret-32chars!!'
vi.stubEnv('KEY_ENCRYPTION_SECRET', SECRET)

// `users` table state — tests mutate this to simulate adds/rotations.
type FakeUser = {
  id: string
  publicKey: string
  encryptedPrivateKey: string
  mcpTokenVersion: number
}
let usersTable: FakeUser[] = []

// Track every db.select() call so tests can assert cache rebuild behaviour.
const dbSelectSpy = vi.fn()

vi.mock('../db/client.js', () => {
  const isUsersIdEq = (clause: unknown): string | null => {
    // Drizzle's eq() returns an object — we only need to detect that the
    // verify path filtered by users.id and pull the requested id back out
    // of the second operand. Our mock schema flattens both sides so we
    // can match on stringified args.
    const s = JSON.stringify(clause)
    const m = s.match(/"([^"]+)"/g)
    if (!m) return null
    // Last quoted string in the eq() clause is the bound id.
    return m[m.length - 1]?.replace(/"/g, '') ?? null
  }

  function selectChain(columns?: unknown) {
    dbSelectSpy(columns)
    return {
      from: () => ({
        where: (clause: unknown) => {
          // verifyMcpToken's freshness gate: select({ mcpTokenVersion })
          // .where(eq(users.id, user.id)) — return one matching row.
          if (columns && typeof columns === 'object') {
            const id = isUsersIdEq(clause)
            const row = usersTable.find((u) => u.id === id)
            return Promise.resolve(row ? [{ mcpTokenVersion: row.mcpTokenVersion }] : [])
          }
          // signMcpToken: select().from(users).where(eq(users.id, ...))
          if (typeof clause === 'object' && clause !== null && 'isNotNull' in (clause as object)) {
            return Promise.resolve(usersTable)
          }
          // findUserByKid rebuild: select().from(users).where(isNotNull(...))
          // Drizzle's isNotNull doesn't carry an id, so distinguish by the
          // absence of a captured id.
          const id = isUsersIdEq(clause)
          if (id) {
            const row = usersTable.find((u) => u.id === id)
            return Promise.resolve(row ? [row] : [])
          }
          return Promise.resolve(usersTable)
        },
      }),
    }
  }

  return {
    db: {
      select: (columns?: unknown) => selectChain(columns),
    },
  }
})

vi.mock('../db/schema.js', () => ({
  users: {
    id: 'users.id',
    publicKey: 'users.publicKey',
    encryptedPrivateKey: 'users.encryptedPrivateKey',
    mcpTokenVersion: 'users.mcpTokenVersion',
  },
}))

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

// drizzle-orm's `eq` and `isNotNull` are imported by jwt.ts. Replace them
// with simple identity helpers so the mock db sees recognisable clauses.
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ eq: col, val }),
  isNotNull: (col: unknown) => ({ isNotNull: col }),
}))

// ── Import under test (after mocks) ───────────────────────────────────────

const { signMcpToken, verifyMcpToken, clearKidCache } = await import('./jwt.js')
const { SignJWT } = await import('jose')
const { createPrivateKey, createHash } = await import('node:crypto')
const { decryptPrivateKey } = await import('../keypair.js')

// ── Helpers ───────────────────────────────────────────────────────────────

function addUser(id: string, version = 1): FakeUser {
  const kp = generateKeypair(SECRET)
  const u: FakeUser = {
    id,
    publicKey: kp.publicKey,
    encryptedPrivateKey: kp.encryptedPrivateKey,
    mcpTokenVersion: version,
  }
  usersTable.push(u)
  return u
}

function decodePayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  return JSON.parse(Buffer.from(parts[1] ?? '', 'base64').toString())
}

function decodeHeader(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  return JSON.parse(Buffer.from(parts[0] ?? '', 'base64').toString())
}

beforeEach(() => {
  usersTable = []
  dbSelectSpy.mockClear()
  // Nuke whatever cache state survived the previous test.
  clearKidCache()
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe('signMcpToken', () => {
  it('signed token has no `exp` claim', async () => {
    const u = addUser('u1')
    const jwt = await signMcpToken(u.id)
    expect(jwt).not.toBeNull()
    const payload = decodePayload(jwt as string)
    expect(payload.exp).toBeUndefined()
    expect(payload.iat).toBeTypeOf('number')
    expect(payload.ver).toBe(1)
  })

  it('emits a 32-char kid in the protected header', async () => {
    const u = addUser('u1')
    const jwt = await signMcpToken(u.id)
    const header = decodeHeader(jwt as string)
    expect(typeof header.kid).toBe('string')
    expect((header.kid as string).length).toBe(32)
  })
})

describe('verifyMcpToken — kid handling', () => {
  it('32-char kid validates and returns the userId', async () => {
    const u = addUser('u1')
    const jwt = await signMcpToken(u.id)
    const userId = await verifyMcpToken(jwt as string)
    expect(userId).toBe('u1')
  })

  it('16-char kid is rejected with Unknown key error', async () => {
    // Breaking change: legacy tokens minted with a 16-char kid header
    // must fail verification. Users re-paste their MCP URL once to
    // pick up a fresh 32-char-kid token from /users/profile.
    const u = addUser('u1')
    const privateKeyDer = decryptPrivateKey(u.encryptedPrivateKey, SECRET)
    const privateKey = createPrivateKey({
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8',
    })
    const legacyKid = createHash('sha256').update(u.publicKey).digest('hex').slice(0, 16)
    const legacyJwt = await new SignJWT({ ver: u.mcpTokenVersion })
      .setProtectedHeader({ alg: 'EdDSA', kid: legacyKid })
      .setIssuer('robin')
      .setAudience('robin-mcp')
      .setIssuedAt()
      .sign(privateKey)
    await expect(verifyMcpToken(legacyJwt)).rejects.toThrow(/Unknown key/)
  })
})

describe('clearKidCache', () => {
  it('per-user eviction forces the next verify to re-read from DB', async () => {
    const u = addUser('u1')
    const jwt = await signMcpToken(u.id)
    // Prime the cache.
    await verifyMcpToken(jwt as string)
    const baselineSelects = dbSelectSpy.mock.calls.length

    // Warm-cache verify: no rebuild needed, only the freshness re-fetch.
    await verifyMcpToken(jwt as string)
    const warmDelta = dbSelectSpy.mock.calls.length - baselineSelects

    // Evict and verify again — now we expect at least one extra select
    // for the cache rebuild on top of the freshness re-fetch.
    clearKidCache(u.id)
    const beforeColdSelects = dbSelectSpy.mock.calls.length
    await verifyMcpToken(jwt as string)
    const coldDelta = dbSelectSpy.mock.calls.length - beforeColdSelects

    expect(coldDelta).toBeGreaterThan(warmDelta)
  })

  it('global eviction (no arg) drops every user`s cache entry', async () => {
    const a = addUser('alpha')
    const b = addUser('beta')
    const tokA = await signMcpToken(a.id)
    const tokB = await signMcpToken(b.id)

    // Prime the cache for both users.
    await verifyMcpToken(tokA as string)
    await verifyMcpToken(tokB as string)

    // Snapshot the warm-cache cost: each verify is now (freshness-only).
    const warmStart = dbSelectSpy.mock.calls.length
    await verifyMcpToken(tokA as string)
    await verifyMcpToken(tokB as string)
    const warmDelta = dbSelectSpy.mock.calls.length - warmStart

    // Global wipe — next verify must re-read the users table.
    clearKidCache()
    const coldStart = dbSelectSpy.mock.calls.length
    await verifyMcpToken(tokA as string)
    // Second verify may piggy-back on the first rebuild since the
    // forward map is repopulated all at once; what matters is that
    // SOMETHING extra was read after the wipe vs. the warm baseline.
    await verifyMcpToken(tokB as string)
    const coldDelta = dbSelectSpy.mock.calls.length - coldStart

    expect(coldDelta).toBeGreaterThan(warmDelta)
  })
})

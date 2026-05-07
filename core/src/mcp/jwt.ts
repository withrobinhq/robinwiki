/***********************************************************************
 * @module mcp/jwt
 *
 * @summary EdDSA JWT signing and verification for MCP token auth.
 *
 * @remarks
 * MCP clients authenticate via a long-lived JWT passed as `?token=`
 * query parameter. Tokens are signed with the user's Ed25519 private
 * key and verified against their public key. The `kid` header maps
 * to users via a SHA-256 fingerprint of the public key.
 *
 * **Token versioning:** each token includes a `ver` claim matching
 * `user.mcpTokenVersion`. Bumping the version in the DB instantly
 * revokes all outstanding tokens for that user.
 *
 * @see {@link signMcpToken} — creates a token for a user
 * @see {@link verifyMcpToken} — validates and returns userId
 * @see {@link module:mcp/server | routes/mcp.ts} — middleware that calls verify
 ***********************************************************************/

import { createPrivateKey, createPublicKey, createHash } from 'node:crypto'
import { SignJWT, jwtVerify, decodeProtectedHeader } from 'jose'
import { eq, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { decryptPrivateKey } from '../keypair.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'mcp-jwt' })

/**
 * In-memory `kid → user` cache to avoid full table scan per MCP request.
 *
 * @remarks Map is keyed by the full 32-char kid plus, opportunistically,
 * the 16-char prefix once the legacy fallback fires. The cache is
 * rebuilt lazily on miss; callers must invoke {@link clearKidCache}
 * after any write to `users.publicKey` or `users.mcpTokenVersion` so we
 * never serve a stale public key after key rotation.
 *
 * @internal
 */
let kidCache: Map<string, typeof users.$inferSelect> | null = null

/**
 * Reverse index `userId → set of kids` so {@link clearKidCache} can
 * evict per-user entries in O(1) without scanning the forward map.
 * Always kept in sync with `kidCache` writes.
 *
 * @internal
 */
const userIdToKids: Map<string, Set<string>> = new Map()

/**
 * Record the `kid → userId` association in the reverse index.
 *
 * @internal
 */
function indexKid(kid: string, userId: string): void {
  let set = userIdToKids.get(userId)
  if (!set) {
    set = new Set()
    userIdToKids.set(userId, set)
  }
  set.add(kid)
}

/**
 * Rebuild the `kid → user` cache from all provisioned users. Also
 * resets the reverse index so the two stay consistent.
 *
 * @internal
 */
async function rebuildKidCache(): Promise<void> {
  const rows = await db.select().from(users).where(isNotNull(users.publicKey))
  kidCache = new Map()
  userIdToKids.clear()
  for (const u of rows) {
    if (!u.publicKey) continue
    const kid = publicKeyId(u.publicKey)
    kidCache.set(kid, u)
    indexKid(kid, u.id)
  }
}

/**
 * Look up a user by their public key fingerprint (`kid`).
 *
 * @remarks
 * Accepts both 32-char (current) and 16-char (legacy, in-flight tokens
 * minted before the kid-length change) fingerprints. On a 16-char miss,
 * scans the cache for any entry whose full 32-char kid begins with the
 * supplied prefix. If nothing matches and the cache hasn't just been
 * rebuilt, force a rebuild and retry once — this keeps already-issued
 * legacy tokens valid even after a process restart with a cold cache.
 *
 * TODO(sec-phase-4): remove the 16-char prefix fallback after one
 * release cycle.
 *
 * @param kid - SHA-256 fingerprint of the user's public key (32 hex
 *              chars for new tokens, 16 hex chars for legacy tokens)
 * @returns User record or `undefined` if not found
 *
 * @internal
 */
async function findUserByKid(kid: string) {
  if (kidCache?.has(kid)) return kidCache.get(kid)

  const tryPrefixMatch = () => {
    if (kid.length !== 16 || !kidCache) return undefined
    for (const [fullKid, user] of kidCache) {
      if (fullKid.startsWith(kid)) {
        // Cache the legacy key so subsequent lookups are O(1) and keep
        // the reverse index in sync so clearKidCache(userId) evicts it.
        kidCache.set(kid, user)
        indexKid(kid, user.id)
        log.debug({ kid }, 'mcp jwt: 16-char kid fallback')
        return user
      }
    }
    return undefined
  }

  // Warm cache: try a prefix match before paying for a DB scan.
  if (kidCache) {
    const hit = tryPrefixMatch()
    if (hit) return hit
    if (kid.length !== 16 && kid.length !== 32) return undefined
  }

  // Cold cache or no exact/prefix hit yet — rebuild once and retry.
  await rebuildKidCache()
  if (kidCache?.has(kid)) return kidCache.get(kid)
  return tryPrefixMatch()
}

/**
 * Derive a `kid` (key ID) from a hex-encoded public key.
 *
 * @remarks Returns 32 hex chars (128 bits) of the SHA-256 digest. The
 * verify path also accepts a 16-char prefix during the legacy-token
 * grace window — see {@link findUserByKid}.
 *
 * @param publicKeyHex - DER-encoded public key as hex string
 * @returns First 32 chars of the SHA-256 hex digest
 *
 * @internal
 */
function publicKeyId(publicKeyHex: string): string {
  return createHash('sha256').update(publicKeyHex).digest('hex').slice(0, 32)
}

/**
 * Sign a long-lived MCP JWT for a user.
 *
 * @remarks
 * Uses the user's Ed25519 private key (decrypted from DB via
 * `KEY_ENCRYPTION_SECRET`). Token includes `ver` claim for
 * revocation support.
 *
 * **No expiry by design.** MCP clients embed the token in a long-lived
 * URL (`/mcp?token=<jwt>`); rotating expiry would force users to
 * re-paste the URL into every client config on a schedule, which they
 * will not do. Revocation is via `users.mcpTokenVersion`: bumping the
 * column instantly invalidates every outstanding token for that user
 * (see verifyMcpToken's freshness gate) and `clearKidCache` evicts the
 * cached row so the next verify rebuilds against fresh DB state. Do
 * **not** add `.setExpirationTime(...)` here — it does not bound risk
 * and breaks the stable-URL contract.
 *
 * @param userId - User to sign a token for
 * @returns Signed JWT string, or `null` if user has no keypair
 * @throws Error if user not found
 */
export async function signMcpToken(userId: string): Promise<string | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId))
  if (!user) throw new Error('User not found')
  if (!user.encryptedPrivateKey || !user.publicKey) return null

  const secret = process.env.KEY_ENCRYPTION_SECRET ?? ''
  const privateKeyDer = decryptPrivateKey(user.encryptedPrivateKey, secret)
  const privateKey = createPrivateKey({
    key: privateKeyDer,
    format: 'der',
    type: 'pkcs8',
  })
  const kid = publicKeyId(user.publicKey)

  return new SignJWT({ ver: user.mcpTokenVersion })
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuer('robin')
    .setAudience('robin-mcp')
    .setIssuedAt()
    .sign(privateKey)
}

/**
 * Verify an MCP JWT and return the authenticated user ID.
 *
 * @remarks
 * **Verification steps:**
 * 1. Decode `kid` from protected header
 * 2. Look up user by `kid` (cache-backed)
 * 3. Verify signature with user's public key
 * 4. Check `ver` claim matches `user.mcpTokenVersion`
 *
 * @param token - Raw JWT string from `?token=` query parameter
 * @returns Authenticated user ID
 * @throws Error if kid missing, user unknown, signature invalid, or token revoked
 */
export async function verifyMcpToken(token: string): Promise<string> {
  /** @step 1 — Extract kid from JWT header */
  const header = decodeProtectedHeader(token)
  if (!header.kid) throw new Error('Missing kid')

  /** @step 2 — Resolve user by kid fingerprint */
  const user = await findUserByKid(header.kid)
  if (!user) throw new Error('Unknown key')

  /** @step 3 — Verify EdDSA signature */
  const publicKeyDer = Buffer.from(user.publicKey, 'hex')
  const publicKey = createPublicKey({
    key: publicKeyDer,
    format: 'der',
    type: 'spki',
  })
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: 'robin',
    audience: 'robin-mcp',
  })

  /** @gate — re-fetch mcpTokenVersion from DB to defeat stale kidCache */
  const [freshUser] = await db
    .select({ mcpTokenVersion: users.mcpTokenVersion })
    .from(users)
    .where(eq(users.id, user.id))
  if (!freshUser || payload.ver !== freshUser.mcpTokenVersion) {
    throw new Error('Token revoked')
  }

  return user.id
}

/**
 * Evict cached `kid → user` entries.
 *
 * @remarks
 * Call after any write to `users.publicKey` or `users.mcpTokenVersion`
 * so the next {@link verifyMcpToken} rebuilds against fresh DB state.
 * Pass `userId` to evict only that user's entries (typical for
 * `/regenerate-mcp` and provisioning); omit the argument to nuke the
 * whole cache (test resets, paranoia).
 *
 * @param userId - If provided, evicts only this user's cached entries
 */
export function clearKidCache(userId?: string): void {
  if (userId === undefined) {
    kidCache = null
    userIdToKids.clear()
    return
  }
  const kids = userIdToKids.get(userId)
  if (!kids) return
  for (const kid of kids) kidCache?.delete(kid)
  userIdToKids.delete(userId)
}

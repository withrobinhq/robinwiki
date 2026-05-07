import { eq, sql } from 'drizzle-orm'
import { generateSlug, makeLookupKey } from '@robin/shared'
import { auth } from '../auth.js'
import { db } from '../db/client.js'
import { people, users } from '../db/schema.js'
import { generateKeypair } from '../keypair.js'
import { clearKidCache } from '../mcp/jwt.js'
import { generateDek, loadMasterKey, wrapDek } from '../lib/crypto.js'
import { logger } from '../lib/logger.js'
import { producer } from '../queue/producer.js'
import { runMigrations } from './run-migrations.js'
import { seedDemoWiki } from './seed-demo-wiki.js'

const log = logger.child({ component: 'jit-provision' })

// null = unchecked, true = user exists (skip all future queries)
let provisioned: boolean | null = null

/**
 * Ensure the single-user app has its one user, provisioning on first login
 * attempt if the users table is empty. After the first check confirms a user
 * exists, all subsequent calls are free (in-memory flag, zero DB queries).
 *
 * NOTE: `INITIAL_PASSWORD` is consumed ONLY here, on the first-boot path. No
 * runtime auth route may read it. Password recovery uses RECOVERY_SECRET +
 * a caller-supplied newPassword — see `core/src/routes/auth-recover.ts`.
 */
export async function ensureFirstUser(): Promise<void> {
  if (provisioned === true) return

  // Run any pending DB migrations before touching the users table
  await runMigrations()

  const [row] = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM users`)
  const userCount = row?.count ?? 0

  if (userCount > 0) {
    provisioned = true
    log.debug('user already exists — skipping provisioning')
    return
  }

  const email = process.env.INITIAL_USERNAME
  const password = process.env.INITIAL_PASSWORD

  if (!email || !password) {
    throw new Error(
      'Users table is empty and INITIAL_USERNAME / INITIAL_PASSWORD env vars are not set — cannot provision'
    )
  }

  log.info({ email }, 'provisioning first user (JIT)')

  const masterKey = loadMasterKey()

  const response = await auth.api.signUpEmail({
    body: {
      email,
      password,
      name: email.split('@')[0] ?? 'admin',
    },
  })

  const signedUpUser = (response as { user?: { id: string; name?: string | null } } | null)
    ?.user
  if (!signedUpUser) {
    throw new Error('sign-up did not return a user object')
  }

  const userId = signedUpUser.id

  const dek = generateDek()
  const wrappedDek = wrapDek(dek, masterKey)

  await db
    .update(users)
    .set({
      encryptedDek: wrappedDek,
      passwordResetRequired: true,
    })
    .where(eq(users.id, userId))

  // Generate keypair inline so the MCP endpoint is available immediately
  // after onboarding — no dependency on BullMQ worker being up.
  const kek = process.env.KEY_ENCRYPTION_SECRET ?? ''
  if (kek) {
    try {
      const { publicKey, encryptedPrivateKey } = generateKeypair(kek)
      await db.update(users).set({ publicKey, encryptedPrivateKey }).where(eq(users.id, userId))
      // Cache is almost certainly empty at first boot, but keep
      // eviction wired so the contract holds across restart paths.
      clearKidCache(userId)
      log.info({ userId }, 'keypair generated inline during provisioning')
    } catch (err) {
      log.error({ userId, err }, 'inline keypair generation failed — falling back to async')
    }
  }

  // Fallback: enqueue async provision job. The worker skips if keypair
  // already exists (guard at processProvisionJob).
  producer
    .enqueueProvision({
      type: 'provision',
      jobId: `provision-${userId}`,
      userId,
      enqueuedAt: new Date().toISOString(),
    })
    .then(() => log.info({ userId }, 'enqueued provision job for keypair generation'))
    .catch((err) => log.error({ userId, err }, 'failed to enqueue provision job'))

  // Owner-Person seed (#238). The user account itself gets a Person row
  // with is_owner = true. Downstream the classifier prompt's [AUTHORSHIP]
  // block resolves "I/me/my" to this Person key instead of the brittle
  // pronoun-substitution rule the fragmenter used to apply.
  // Idempotent + error-isolated — owner provisioning must never block
  // sign-in.
  try {
    await ensureOwnerPerson(signedUpUser.name ?? null, email)
  } catch (err) {
    log.error({ userId, err }, 'owner-Person seed failed — continuing')
  }

  // First-run demo content: seed the Transformer fixture wiki so the user
  // lands on populated onboarding content and we smoke-test the wiki stack.
  // Idempotent + error-isolated inside seedDemoWiki — never blocks sign-in.
  await seedDemoWiki()

  provisioned = true
  log.info({ userId, email }, 'first user provisioned with DEK and password_reset_required=true')
}

/**
 * Insert the owner-Person row if missing. Single-tenant: at most one row
 * may carry is_owner = true (DB-enforced by people_is_owner_uidx).
 *
 * @param signedUpName Best-available human name from the auth provider.
 *                     Falls back to the email local-part if absent or blank.
 * @param email        The user's email — used to derive a fallback display
 *                     name and to keep the owner Person discoverable in
 *                     case the user later updates their profile.
 */
export async function ensureOwnerPerson(
  signedUpName: string | null,
  email: string
): Promise<{ personKey: string; isNew: boolean }> {
  const [existing] = await db
    .select({ lookupKey: people.lookupKey })
    .from(people)
    .where(eq(people.isOwner, true))
    .limit(1)

  if (existing) {
    return { personKey: existing.lookupKey, isNew: false }
  }

  const fallback = email.split('@')[0] ?? 'owner'
  const trimmed = (signedUpName ?? '').trim()
  const displayName = trimmed.length > 0 ? trimmed : fallback

  const personKey = makeLookupKey('person')
  const slug = generateSlug(`owner-${displayName}`)

  await db.insert(people).values({
    lookupKey: personKey,
    slug,
    name: displayName,
    canonicalName: displayName,
    aliases: [],
    verified: true,
    isOwner: true,
    state: 'RESOLVED',
  })

  log.info({ personKey, displayName }, 'owner-Person seeded')
  return { personKey, isNew: true }
}

/**
 * Lookup the canonical owner-Person name. Returns null if no owner row
 * exists yet — callers should fall back to a generic "the owner" label
 * in that case so the [AUTHORSHIP] block still renders.
 */
export async function loadOwnerPersonName(): Promise<{
  personKey: string
  name: string
} | null> {
  const [row] = await db
    .select({ lookupKey: people.lookupKey, name: people.name })
    .from(people)
    .where(eq(people.isOwner, true))
    .limit(1)
  if (!row) return null
  return { personKey: row.lookupKey, name: row.name }
}


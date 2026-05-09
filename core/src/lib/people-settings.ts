import { eq, isNull, sql } from 'drizzle-orm'
import { appSettings, people } from '../db/schema.js'
import type { DB } from '../db/client.js'
import { emitAuditEvent } from '../db/audit.js'
import type { KnownPerson } from '@robin/agent'

/**
 * Stream P helpers — shared between the worker pipeline (entityExtract)
 * and the MCP `log_fragment` handler. Centralised here so both surfaces
 * read the same pending-people pool, the same auto-accept toggle, and
 * therefore produce identical extraction outcomes.
 */

const AUTO_ACCEPT_KEY = 'auto_accept_persons'

export async function loadAutoAcceptPersons(db: DB): Promise<boolean> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, AUTO_ACCEPT_KEY))
    .limit(1)
  if (!row) return false
  // Stored as raw jsonb. Most call paths write `true` / `false` /
  // `"true"` — treat anything truthy that is NOT the literal string
  // "false" or boolean `false` as a positive toggle.
  const v = row.value
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true' || v === '1'
  return Boolean(v)
}

export async function setAutoAcceptPersons(
  db: DB,
  next: boolean
): Promise<{ previous: boolean; current: boolean }> {
  const previous = await loadAutoAcceptPersons(db)
  await db
    .insert(appSettings)
    .values({ key: AUTO_ACCEPT_KEY, value: next })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updatedAt: new Date() },
    })
  return { previous, current: next }
}

/** Load the verified-only matcher pool (used for the LLM prompt). */
export async function loadVerifiedPeople(db: DB): Promise<KnownPerson[]> {
  const rows = await db
    .select({
      lookupKey: people.lookupKey,
      canonicalName: people.canonicalName,
      aliases: people.aliases,
    })
    .from(people)
    .where(sql`${people.status} = 'verified' AND ${people.deletedAt} IS NULL`)
  return rows.map((r) => ({
    lookupKey: r.lookupKey,
    canonicalName: r.canonicalName,
    aliases: r.aliases ?? [],
  }))
}

/** Load the pending-people pool. Used for extract-time dedup only. */
export async function loadPendingPeople(db: DB): Promise<KnownPerson[]> {
  const rows = await db
    .select({
      lookupKey: people.lookupKey,
      canonicalName: people.canonicalName,
      aliases: people.aliases,
    })
    .from(people)
    .where(sql`${people.status} = 'pending' AND ${people.deletedAt} IS NULL`)
  return rows.map((r) => ({
    lookupKey: r.lookupKey,
    canonicalName: r.canonicalName,
    aliases: r.aliases ?? [],
  }))
}

/**
 * Insert a new person row. Centralised here so the worker pipeline,
 * MCP `log_fragment`, and MCP `create_person` all stamp the right
 * provenance fields uniformly.
 */
export async function insertExtractedPerson(
  db: DB,
  input: {
    lookupKey: string
    canonicalName: string
    status: 'verified' | 'pending'
    createdVia: 'extractor_pending' | 'extractor_auto'
    extractedFromFragmentId: string | null
  }
): Promise<void> {
  const trimmed = input.canonicalName.trim() || '(unnamed)'
  const slug =
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || `person-${input.lookupKey.slice(-6).toLowerCase()}`
  await db
    .insert(people)
    .values({
      lookupKey: input.lookupKey,
      slug,
      name: trimmed,
      canonicalName: trimmed,
      aliases: [],
      verified: input.status === 'verified',
      status: input.status,
      createdVia: input.createdVia,
      extractedFromFragmentId: input.extractedFromFragmentId ?? null,
      state: 'PENDING',
    })
    .onConflictDoNothing()

  await emitAuditEvent(db, {
    entityType: 'person',
    entityId: input.lookupKey,
    eventType: 'created',
    source: 'system',
    summary: `Person ${input.status === 'pending' ? 'queued for review' : 'created'}: ${trimmed}`,
    detail: {
      personKey: input.lookupKey,
      canonicalName: trimmed,
      status: input.status,
      createdVia: input.createdVia,
      extractedFromFragmentId: input.extractedFromFragmentId,
    },
  })
  void isNull // silence unused import in tighter compile modes
}

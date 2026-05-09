/**
 * Seed the Transformer-architecture wiki fixture into Postgres.
 *
 * Exposed as a reusable library so both the `seed-fixture` CLI script
 * and the first-run bootstrap can share identical semantics.
 *
 * Identity policy:
 * - Fixture-declared `id` values (e.g. 'p-ashish-vaswani') are decorative
 *   for frontend preview; primary keys are generated via `makeLookupKey`
 *   on first seed.
 * - Rows are keyed by **slug** on subsequent runs, matching the sidecar
 *   builder's resolution strategy, so re-running updates in place without
 *   duplicating.
 *
 * Idempotency:
 * - `seedFixture()` is safe to call on every boot; existing rows are
 *   updated in place.
 * - `isFixtureSeeded()` answers the cheaper question "does the fixture
 *   wiki already exist?" for the bootstrap gate.
 *
 * Pure projection lives in `seedFixtureProjection.ts` so the CLI
 * dry-run path doesn't need a DB connection.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { makeLookupKey } from '@robin/shared'
import type { WikiCitationDeclaration } from '@robin/shared/schemas/sidecar'
import { db } from '../db/client.js'
import {
  wikis,
  people,
  fragments,
  entries,
  edges,
} from '../db/schema.js'
import { logger } from './logger.js'
import { FIXTURE_WIKI_SLUG, projectFixture } from './seedFixtureProjection.js'

const log = logger.child({ component: 'seed-fixture' })

export interface SeedFixtureResult {
  seeded: boolean
  skipped: boolean
  wikiKey: string | null
  slug: string
  peopleCount: number
  fragmentCount: number
  entryCount: number
}

/**
 * Cheap slug lookup — returns true iff the fixture wiki row already
 * exists (and is not soft-deleted). Used by the bootstrap gate to
 * short-circuit without computing the fixture projection.
 */
export async function isFixtureSeeded(): Promise<boolean> {
  const [existing] = await db
    .select({ lookupKey: wikis.lookupKey })
    .from(wikis)
    .where(and(eq(wikis.slug, FIXTURE_WIKI_SLUG), isNull(wikis.deletedAt)))
    .limit(1)
  return !!existing
}

/**
 * Upsert the Transformer fixture wiki + people + fragments + entry and
 * their edges. Idempotent; re-running updates existing rows in place.
 */
export async function seedFixture(): Promise<SeedFixtureResult> {
  const projected = projectFixture()

  // ── Wiki: upsert by slug ─────────────────────────────────────────
  const [existingWiki] = await db
    .select({ lookupKey: wikis.lookupKey })
    .from(wikis)
    .where(and(eq(wikis.slug, projected.wiki.slug), isNull(wikis.deletedAt)))
    .limit(1)

  const wikiKey = existingWiki?.lookupKey ?? makeLookupKey('wiki')

  if (existingWiki) {
    await db
      .update(wikis)
      .set({
        name: projected.wiki.name,
        type: projected.wiki.type,
        content: projected.wiki.content,
        state: 'RESOLVED',
        metadata: projected.wiki.metadata,
        // citationDeclarations need fragmentIds patched after fragment
        // upserts resolve real lookup keys — set below.
        autoregen: false,
        updatedAt: new Date(),
      })
      .where(eq(wikis.lookupKey, wikiKey))
    log.info({ wikiKey, slug: projected.wiki.slug }, 'updated existing wiki')
  } else {
    await db.insert(wikis).values({
      lookupKey: wikiKey,
      slug: projected.wiki.slug,
      name: projected.wiki.name,
      type: projected.wiki.type,
      content: projected.wiki.content,
      state: 'RESOLVED',
      metadata: projected.wiki.metadata,
      autoregen: false,
    })
    log.info({ wikiKey, slug: projected.wiki.slug }, 'inserted new wiki')
  }

  // ── People: upsert by slug ───────────────────────────────────────
  // Existence lookup intentionally ignores `deletedAt`: the underlying
  // unique index on `people.slug` is global (not partial), so a soft-
  // deleted row with the same slug still blocks an insert. Re-seed must
  // resurrect such rows in place rather than retry an insert that would
  // collide on the unique constraint (issue #205).
  const personKeysBySlug = new Map<string, string>()
  for (const p of projected.people) {
    const [existing] = await db
      .select({ lookupKey: people.lookupKey })
      .from(people)
      .where(eq(people.slug, p.slug))
      .limit(1)

    const key = existing?.lookupKey ?? makeLookupKey('person')
    if (existing) {
      await db
        .update(people)
        .set({
          name: p.name,
          canonicalName: p.name,
          relationship: p.relationship,
          state: 'RESOLVED',
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(people.lookupKey, key))
    } else {
      await db.insert(people).values({
        lookupKey: key,
        slug: p.slug,
        name: p.name,
        canonicalName: p.name,
        relationship: p.relationship,
        state: 'RESOLVED',
        verified: false,
        aliases: [],
      })
    }
    personKeysBySlug.set(p.slug, key)
  }

  // ── Fragments: upsert by slug ────────────────────────────────────
  // Same idempotency contract as people: the unique index on
  // `fragments.slug` is global, so resurrect soft-deleted rows in place.
  const fragmentKeysBySlug = new Map<string, string>()
  for (const f of projected.fragments) {
    const [existing] = await db
      .select({ lookupKey: fragments.lookupKey })
      .from(fragments)
      .where(eq(fragments.slug, f.slug))
      .limit(1)

    const key = existing?.lookupKey ?? makeLookupKey('frag')
    if (existing) {
      await db
        .update(fragments)
        .set({
          title: f.title,
          content: f.content,
          state: 'RESOLVED',
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(fragments.lookupKey, key))
    } else {
      await db.insert(fragments).values({
        lookupKey: key,
        slug: f.slug,
        title: f.title,
        type: 'observation',
        content: f.content,
        state: 'RESOLVED',
        tags: [],
      })
    }
    fragmentKeysBySlug.set(f.slug, key)
  }

  // ── Entry: upsert by slug ────────────────────────────────────────
  // `raw_sources.slug` also has a global unique index — same resurrect-
  // in-place strategy for re-seed idempotency.
  let entryKey: string | null = null
  if (projected.entry) {
    const [existing] = await db
      .select({ lookupKey: entries.lookupKey })
      .from(entries)
      .where(eq(entries.slug, projected.entry.slug))
      .limit(1)

    entryKey = existing?.lookupKey ?? makeLookupKey('entry')
    if (existing) {
      await db
        .update(entries)
        .set({
          title: projected.entry.title,
          content: projected.entry.content,
          state: 'RESOLVED',
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(entries.lookupKey, entryKey))
    } else {
      await db.insert(entries).values({
        lookupKey: entryKey,
        slug: projected.entry.slug,
        title: projected.entry.title,
        content: projected.entry.content,
        type: 'thought',
        source: 'seed',
        state: 'RESOLVED',
        ingestStatus: 'complete',
      })
    }
  }

  // ── Patch citationDeclarations with real fragment lookup keys ───
  // Fixture citations reference fragmentSlugs, but the column stores
  // fragmentIds that must match real lookup keys for buildSidecar to
  // resolve them on read.
  const patchedDeclarations: WikiCitationDeclaration[] =
    projected.wiki.citationDeclarations.map((d) => ({
      sectionAnchor: d.sectionAnchor,
      fragmentIds: d.fragmentIds
        .map((slugOrKey) => fragmentKeysBySlug.get(slugOrKey))
        .filter((k): k is string => !!k),
    }))

  await db
    .update(wikis)
    .set({ citationDeclarations: patchedDeclarations })
    .where(eq(wikis.lookupKey, wikiKey))

  // ── Edges: FRAGMENT_IN_WIKI (every fragment linked to the wiki) ──
  for (const fragKey of fragmentKeysBySlug.values()) {
    await db
      .insert(edges)
      .values({
        id: crypto.randomUUID(),
        srcType: 'fragment',
        srcId: fragKey,
        dstType: 'wiki',
        dstId: wikiKey,
        edgeType: 'FRAGMENT_IN_WIKI',
        attrs: { score: 1.0, method: 'seed', signal: 'strong' },
      })
      .onConflictDoNothing()
  }

  // ── Edges: FRAGMENT_MENTIONS_PERSON (every author mentioned in every
  //          fragment; a coarse model, but matches the wiki body's
  //          intent that the three authors co-wrote the paper being
  //          summarised by every fragment.)
  for (const fragKey of fragmentKeysBySlug.values()) {
    for (const personKey of personKeysBySlug.values()) {
      await db
        .insert(edges)
        .values({
          id: crypto.randomUUID(),
          srcType: 'fragment',
          srcId: fragKey,
          dstType: 'person',
          dstId: personKey,
          edgeType: 'FRAGMENT_MENTIONS_PERSON',
        })
        .onConflictDoNothing()
    }
  }

  // ── Edges: ENTRY_HAS_FRAGMENT (entry → every fragment it spawned) ─
  if (entryKey) {
    for (const fragKey of fragmentKeysBySlug.values()) {
      await db
        .insert(edges)
        .values({
          id: crypto.randomUUID(),
          srcType: 'raw_source',
          srcId: entryKey,
          dstType: 'fragment',
          dstId: fragKey,
          edgeType: 'ENTRY_HAS_FRAGMENT',
        })
        .onConflictDoNothing()
    }
  }

  const result: SeedFixtureResult = {
    seeded: true,
    skipped: false,
    wikiKey,
    slug: projected.wiki.slug,
    peopleCount: projected.people.length,
    fragmentCount: projected.fragments.length,
    entryCount: projected.entry ? 1 : 0,
  }

  log.info(
    result,
    `Seeded wiki ${projected.wiki.slug} (key=${wikiKey}) with ${result.peopleCount} people, ${result.fragmentCount} fragments, ${result.entryCount} entry`
  )

  return result
}

// Re-export for callers that want a single import path.
export { projectFixture, FIXTURE_WIKI_SLUG } from './seedFixtureProjection.js'

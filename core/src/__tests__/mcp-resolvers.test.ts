import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { resolveSlug, stripFrontmatter } from '../mcp/resolvers.js'

// ─── stripFrontmatter ───

describe('stripFrontmatter', () => {
  it('removes YAML frontmatter', () => {
    const input = '---\ntitle: Hello\ntags: [a]\n---\nBody content here'
    expect(stripFrontmatter(input)).toBe('Body content here')
  })

  it('returns content unchanged when no frontmatter', () => {
    const input = 'Just plain text'
    expect(stripFrontmatter(input)).toBe('Just plain text')
  })

  it('handles empty body after frontmatter', () => {
    const input = '---\ntitle: Hello\n---\n'
    expect(stripFrontmatter(input)).toBe('')
  })

  it('handles Windows-style line endings', () => {
    const input = '---\r\ntitle: Hello\r\n---\r\nBody'
    expect(stripFrontmatter(input)).toBe('Body')
  })
})

// ─── resolveSlug ───

describe('resolveSlug', () => {
  const candidates = [
    { slug: 'ai-infrastructure', name: 'AI Infrastructure & Startups' },
    { slug: 'weekly-review', name: 'Weekly Review' },
    { slug: 'project-robin', name: 'Project Robin Notes' },
  ]

  it('returns exact slug match', () => {
    const result = resolveSlug('ai-infrastructure', candidates)
    expect(result).toEqual({ match: candidates[0] })
  })

  it('returns exact match case-insensitively', () => {
    const result = resolveSlug('AI-Infrastructure', candidates)
    // lowercased input matches slug 'ai-infrastructure'
    expect(result).toEqual({ match: candidates[0] })
  })

  it('returns fuzzy match above threshold', () => {
    const result = resolveSlug('ai-infra', candidates)
    expect('match' in result).toBe(true)
    if ('match' in result) {
      expect(result.match.slug).toBe('ai-infrastructure')
    }
  })

  it('returns fuzzy match on name field', () => {
    const result = resolveSlug('weekly review', candidates)
    expect('match' in result).toBe(true)
    if ('match' in result) {
      expect(result.match.slug).toBe('weekly-review')
    }
  })

  it('returns error with suggestions for no match', () => {
    const result = resolveSlug('zzz-nonexistent-topic', candidates)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('No match found')
      expect(result.suggestions).toHaveLength(3)
    }
  })

  it('returns empty suggestions for empty candidates', () => {
    const result = resolveSlug('anything', [])
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.suggestions).toEqual([])
    }
  })
})

// ─── Resolver integration tests (real DB) ───

import type postgres from 'postgres'
import type { McpResolverDeps } from '../mcp/resolvers.js'
import { listWikis, getWiki, getFragment, findPersonById, findPersonByQuery } from '../mcp/resolvers.js'
import { makeLookupKey, ObjectType } from '@robin/shared'
import { entries, fragments, wikis, people, edges } from '../db/schema.js'
import {
  ensureTestDatabase,
  pushTestSchema,
  getTestDb,
  cleanupTestDb,
  createTestUser,
  createTestVault,
  clearTestData,
  canConnectToTestDb,
} from './test-setup.js'

const dbAvailable = await canConnectToTestDb()

describe.skipIf(!dbAvailable)('MCP resolvers (real DB)', () => {
  let db: ReturnType<typeof getTestDb>['db']
  let sqlConn: ReturnType<typeof postgres>
  let testUserId: string

  // Reusable keys
  let entryKey: string
  let wikiKey: string
  let fragKey1: string
  let fragKey2: string
  let personKey1: string
  let personKey2: string

  beforeAll(async () => {
    await ensureTestDatabase()
    pushTestSchema()
    const conn = getTestDb()
    db = conn.db
    sqlConn = conn.sql
    testUserId = await createTestUser(db)
    await createTestVault(db)
  }, 60_000)

  afterAll(async () => {
    await cleanupTestDb(sqlConn)
  })

  beforeEach(async () => {
    await clearTestData(db)

    // Seed test data
    entryKey = makeLookupKey(ObjectType.ENTRY)
    wikiKey = makeLookupKey(ObjectType.THREAD)
    fragKey1 = makeLookupKey(ObjectType.FRAGMENT)
    fragKey2 = makeLookupKey(ObjectType.FRAGMENT)
    personKey1 = makeLookupKey(ObjectType.PERSON)
    personKey2 = makeLookupKey(ObjectType.PERSON)

    await db.insert(entries).values({
      lookupKey: entryKey,
      slug: 'mcp-test-entry',
      state: 'RESOLVED',
      title: 'MCP Test Entry',
      content: 'Some content',
    })

    await db.insert(wikis).values({
      lookupKey: wikiKey,
      slug: 'ai-infrastructure',
      name: 'AI Infrastructure & Startups',
      type: 'log',
      state: 'RESOLVED',
      content:
        '---\ntitle: AI\n---\n' +
        '# Overview\n' +
        'Wiki body about AI infra. Context from [[person:david-chen]].\n\n' +
        '## Current Status\n' +
        'See [[wiki:ai-infrastructure]] for prior notes.\n',
      metadata: {
        infobox: {
          rows: [
            { label: 'Status', value: 'active', valueKind: 'status' },
          ],
        },
      },
      lastRebuiltAt: new Date('2025-06-01'),
    })

    await db.insert(fragments).values([
      {
        lookupKey: fragKey1,
        slug: 'vector-db-note',
        title: 'Vector DB Note',
        type: 'observation',
        tags: ['ai', 'databases'],
        content:
          '---\ntitle: Vector DB Note\ntags: [ai, databases]\n---\n' +
          '# Vector DB Note\n' +
          'Content about vector DBs — see [[person:david-chen]].\n',
        entryId: entryKey,
        state: 'RESOLVED',
      },
      {
        lookupKey: fragKey2,
        slug: 'startup-pivot',
        title: 'Startup Pivot Discussion',
        type: 'observation',
        tags: ['startups'],
        content: '---\ntitle: Pivot\n---\nStartup pivot snippet.',
        entryId: entryKey,
        state: 'RESOLVED',
      },
    ])

    await db.insert(people).values([
      {
        lookupKey: personKey1,
        slug: 'david-chen',
        name: 'David Chen',
        relationship: 'colleague',
        aliases: ['Dave', 'D. Chen'],
        content:
          '---\nname: David Chen\n---\n' +
          '# Background\n' +
          'Person body about David — works with [[wiki:ai-infrastructure]].\n',
        state: 'RESOLVED',
      },
      {
        lookupKey: personKey2,
        slug: 'sarah-jones',
        name: 'Sarah Jones',
        relationship: 'friend',
        aliases: [],
        content: '',
        state: 'RESOLVED',
      },
    ])

    // Edges: both fragments in thread, frag1 mentions person1
    await db.insert(edges).values([
      {
        id: crypto.randomUUID(),
        srcType: 'frag',
        srcId: fragKey1,
        dstType: 'wiki',
        dstId: wikiKey,
        edgeType: 'FRAGMENT_IN_WIKI',
      },
      {
        id: crypto.randomUUID(),
        srcType: 'frag',
        srcId: fragKey2,
        dstType: 'wiki',
        dstId: wikiKey,
        edgeType: 'FRAGMENT_IN_WIKI',
      },
      {
        id: crypto.randomUUID(),
        srcType: 'frag',
        srcId: fragKey1,
        dstType: 'person',
        dstId: personKey1,
        edgeType: 'FRAGMENT_MENTIONS_PERSON',
      },
    ])
  })

  // ─── listWikis ───

  describe('listWikis', () => {
    it('returns wikis with correct fragment counts from edge joins', async () => {
      const result = await listWikis({ db })

      expect(result).toHaveLength(1)
      expect(result[0].slug).toBe('ai-infrastructure')
      expect(result[0].name).toBe('AI Infrastructure & Startups')
      expect(result[0].fragmentCount).toBe(2)
      expect(result[0].wikiPreview).toBe('Wiki body about AI infra.')
      expect(result[0].lastRebuiltAt).toBe('2025-06-01T00:00:00.000Z')
    })

    it('returns empty array when no wikis exist', async () => {
      await db.delete(edges)
      await db.delete(wikis)
      const result = await listWikis({ db })
      expect(result).toEqual([])
    })

    it('excludes soft-deleted wikis', async () => {
      await db
        .update(wikis)
        .set({ deletedAt: new Date() })
        .where(eq(wikis.lookupKey, wikiKey))

      const result = await listWikis({ db })
      expect(result).toEqual([])
    })

    it('excludes soft-deleted edges from fragment count', async () => {
      // Soft-delete one edge
      await db.update(edges).set({ deletedAt: new Date() }).where(eq(edges.srcId, fragKey2))

      const result = await listWikis({ db })
      expect(result[0].fragmentCount).toBe(1)
    })

    it('returns empty preview when content is empty', async () => {
      await db.update(wikis).set({ content: '' }).where(eq(wikis.lookupKey, wikiKey))
      const result = await listWikis({ db })
      expect(result[0].wikiPreview).toBe('')
    })

    // ─── sidecar shape (list policy: refs only) ───

    it('includes refs for [[kind:slug]] tokens in content', async () => {
      const result = await listWikis({ db })
      expect(result).toHaveLength(1)
      // person:david-chen token in the seed body should resolve to the
      // fixture person row.
      expect(result[0].refs).toHaveProperty('person:david-chen')
      expect(result[0].refs['person:david-chen']).toMatchObject({
        kind: 'person',
        slug: 'david-chen',
        label: 'David Chen',
      })
    })

    it('omits infobox and sections from list rows (list policy)', async () => {
      const result = await listWikis({ db })
      expect(result[0]).not.toHaveProperty('infobox')
      expect(result[0]).not.toHaveProperty('sections')
    })

    it('returns an empty refs map when content has no tokens', async () => {
      await db
        .update(wikis)
        .set({ content: '# Overview\nNo tokens here at all.' })
        .where(eq(wikis.lookupKey, wikiKey))
      const result = await listWikis({ db })
      expect(result[0].refs).toEqual({})
    })
  })

  // ─── getWiki ───

  describe('getWiki', () => {
    it('resolves exact slug and returns wiki body + linked fragments', async () => {
      const result = await getWiki({ db }, 'ai-infrastructure')

      expect('thread' in result).toBe(true)
      if ('thread' in result) {
        expect(result.thread.slug).toBe('ai-infrastructure')
        expect(result.thread.state).toBe('RESOLVED')
        expect(result.wikiBody).toBe('Wiki body about AI infra.')
        expect(result.fragments).toHaveLength(2)

        const slugs = result.fragments.map((f) => f.slug).sort()
        expect(slugs).toEqual(['startup-pivot', 'vector-db-note'])
      }
    })

    it('resolves fuzzy slug match', async () => {
      const result = await getWiki({ db }, 'ai-infra')
      expect('thread' in result).toBe(true)
      if ('thread' in result) {
        expect(result.thread.slug).toBe('ai-infrastructure')
      }
    })

    it('returns error for no match', async () => {
      const result = await getWiki({ db }, 'zzz-nonexistent')
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.suggestions).toContain('ai-infrastructure')
      }
    })

    it('excludes soft-deleted fragment edges', async () => {
      await db.update(edges).set({ deletedAt: new Date() }).where(eq(edges.srcId, fragKey2))

      const result = await getWiki({ db }, 'ai-infrastructure')
      expect('thread' in result).toBe(true)
      if ('thread' in result) {
        expect(result.fragments).toHaveLength(1)
        expect(result.fragments[0].slug).toBe('vector-db-note')
      }
    })

    // ─── sidecar shape (full detail) ───

    it('emits sidecar refs/sections/infobox on thread detail', async () => {
      const result = await getWiki({ db }, 'ai-infrastructure')
      expect('thread' in result).toBe(true)
      if (!('thread' in result)) return

      // refs: tokens in the seed body
      expect(result.refs).toHaveProperty('person:david-chen')
      expect(result.refs['person:david-chen']).toMatchObject({
        kind: 'person',
        slug: 'david-chen',
      })
      expect(result.refs).toHaveProperty('wiki:ai-infrastructure')
      expect(result.refs['wiki:ai-infrastructure']).toMatchObject({
        kind: 'wiki',
        slug: 'ai-infrastructure',
      })

      // sections: headings in the seed body with stable slug anchors
      const anchors = result.sections.map((s) => s.anchor)
      expect(anchors).toEqual(['overview', 'current-status'])
      // No LLM-declared citations yet — citations[] is always an array
      for (const section of result.sections) {
        expect(Array.isArray(section.citations)).toBe(true)
      }

      // infobox: sourced from wikis.metadata.infobox (seeded above)
      expect(result.infobox).toEqual({
        rows: [{ label: 'Status', value: 'active', valueKind: 'status' }],
      })
    })

    it('emits infobox=null when wikis.metadata is unset', async () => {
      await db.update(wikis).set({ metadata: null }).where(eq(wikis.lookupKey, wikiKey))
      const result = await getWiki({ db }, 'ai-infrastructure')
      expect('thread' in result).toBe(true)
      if ('thread' in result) {
        expect(result.infobox).toBeNull()
      }
    })
  })

  // ─── getFragment ───

  describe('getFragment', () => {
    it('resolves exact slug and returns content + frontmatter', async () => {
      const result = await getFragment({ db }, 'vector-db-note')

      expect('slug' in result).toBe(true)
      if ('slug' in result) {
        expect(result.slug).toBe('vector-db-note')
        expect(result.title).toBe('Vector DB Note')
        expect(result.tags).toEqual(['ai', 'databases'])
        expect(result.content).toBe('Content about vector DBs.')
        expect(result.frontmatter).toContain('title: Vector DB Note')
      }
    })

    it('resolves fuzzy slug match', async () => {
      const result = await getFragment({ db }, 'vector-db')
      expect('slug' in result).toBe(true)
      if ('slug' in result) {
        expect(result.slug).toBe('vector-db-note')
      }
    })

    it('returns error for unknown slug', async () => {
      const result = await getFragment({ db }, 'zzz-missing')
      expect('error' in result).toBe(true)
    })

    it('excludes soft-deleted fragments', async () => {
      await db
        .update(fragments)
        .set({ deletedAt: new Date() })
        .where(eq(fragments.lookupKey, fragKey1))

      const result = await getFragment({ db }, 'vector-db-note')
      expect('error' in result).toBe(true)
    })

    // ─── sidecar shape (refs + sections; no infobox for fragments) ───

    it('emits sidecar refs and sections on fragment detail', async () => {
      const result = await getFragment({ db }, 'vector-db-note')
      expect('slug' in result).toBe(true)
      if (!('slug' in result)) return

      expect(result.refs).toHaveProperty('person:david-chen')
      expect(result.refs['person:david-chen']).toMatchObject({
        kind: 'person',
        slug: 'david-chen',
      })

      const anchors = result.sections.map((s) => s.anchor)
      expect(anchors).toContain('vector-db-note')
      for (const section of result.sections) {
        // Fragments never carry citations — always []
        expect(section.citations).toEqual([])
      }

      // Fragments never expose an infobox field
      expect(result).not.toHaveProperty('infobox')
    })
  })

  // ─── findPersonByQuery ───

  describe('findPersonByQuery', () => {
    it('resolves exact name and returns body + linked fragments', async () => {
      const result = await findPersonByQuery({ db }, 'David Chen')

      expect('person' in result).toBe(true)
      if ('person' in result) {
        expect(result.person.name).toBe('David Chen')
        expect(result.person.slug).toBe('david-chen')
        expect(result.person.aliases).toEqual(['Dave', 'D. Chen'])
        expect(result.person.relationship).toBe('colleague')
        expect(result.body).toBe('Person body about David.')
        expect(result.fragments).toHaveLength(1)
        expect(result.fragments[0].slug).toBe('vector-db-note')
      }
    })

    it('resolves alias match', async () => {
      const result = await findPersonByQuery({ db }, 'Dave')
      expect('person' in result).toBe(true)
      if ('person' in result) {
        expect(result.person.name).toBe('David Chen')
      }
    })

    it('resolves fuzzy name match', async () => {
      const result = await findPersonByQuery({ db }, 'david')
      expect('person' in result).toBe(true)
      if ('person' in result) {
        expect(result.person.name).toBe('David Chen')
      }
    })

    it('returns error with suggestions for no match', async () => {
      const result = await findPersonByQuery({ db }, 'Zzz Nonexistent')
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.suggestions).toContain('David Chen')
      }
    })

    it('excludes soft-deleted people', async () => {
      await db.update(people).set({ deletedAt: new Date() }).where(eq(people.lookupKey, personKey1))

      const result = await findPersonByQuery({ db }, 'David Chen')
      expect('error' in result).toBe(true)
    })

    it('excludes soft-deleted mention edges from fragment list', async () => {
      // Soft-delete the mention edge
      await db.update(edges).set({ deletedAt: new Date() }).where(eq(edges.dstId, personKey1))

      const result = await findPersonByQuery({ db }, 'David Chen')
      expect('person' in result).toBe(true)
      if ('person' in result) {
        expect(result.fragments).toHaveLength(0)
      }
    })

    // ─── sidecar shape (refs + server-derived infobox + sections) ───

    it('emits sidecar refs/sections and a server-derived infobox', async () => {
      const result = await findPersonByQuery({ db }, 'David Chen')
      expect('person' in result).toBe(true)
      if (!('person' in result)) return

      // refs drawn from tokens in the person body
      expect(result.refs).toHaveProperty('wiki:ai-infrastructure')
      expect(result.refs['wiki:ai-infrastructure']).toMatchObject({
        kind: 'wiki',
        slug: 'ai-infrastructure',
      })

      // sections from the body headings
      expect(result.sections.map((s) => s.anchor)).toContain('background')

      // Server-derived infobox: contract pins the label set
      expect(result.infobox).not.toBeNull()
      const labels = result.infobox?.rows.map((r) => r.label)
      expect(labels).toContain('Relationship')
      expect(labels).toContain('Aliases')
      expect(labels).toContain('First mentioned')
      expect(labels).toContain('Mentions')
      // Mentions row reflects the one FRAGMENT_MENTIONS_PERSON edge we seeded
      const mentions = result.infobox?.rows.find((r) => r.label === 'Mentions')
      expect(mentions?.value).toBe('1')
    })

    it('emits infobox=null for a person with empty relationship/aliases and no mentions', async () => {
      // sarah-jones has no mention edges and an empty body; createdAt is
      // still set, so the "First mentioned" row will populate. To force the
      // all-empty case, we have to strip the default-now createdAt too.
      await db
        .update(people)
        .set({ relationship: '', aliases: [], createdAt: null as unknown as Date })
        .where(eq(people.lookupKey, personKey2))

      const result = await findPersonByQuery({ db }, 'Sarah Jones')
      expect('person' in result).toBe(true)
      if ('person' in result) {
        expect(result.infobox).toBeNull()
      }
    })
  })

  // ─── findPersonById ───

  describe('findPersonById', () => {
    it('returns person by exact lookupKey', async () => {
      const result = await findPersonById({ db }, personKey1)
      expect('person' in result).toBe(true)
      if ('person' in result) {
        expect(result.person.name).toBe('David Chen')
        expect(result.person.slug).toBe('david-chen')
        expect(typeof result.body).toBe('string')
        expect(result.body).toBe('Person body about David.')
      }
    })

    it('returns error for unknown id', async () => {
      const result = await findPersonById({ db }, 'person01ZZZZZZZZZZZZZZZZZZZZZZZZZZ')
      expect('error' in result).toBe(true)
    })

    it('returns linked fragments', async () => {
      const result = await findPersonById({ db }, personKey1)
      expect('person' in result).toBe(true)
      if ('person' in result) {
        expect(result.fragments).toHaveLength(1)
        expect(result.fragments[0].slug).toBe('vector-db-note')
      }
    })

    it('excludes soft-deleted people', async () => {
      await db.update(people).set({ deletedAt: new Date() }).where(eq(people.lookupKey, personKey1))
      const result = await findPersonById({ db }, personKey1)
      expect('error' in result).toBe(true)
    })

    it('emits sidecar refs/sections and a server-derived infobox (by id)', async () => {
      const result = await findPersonById({ db }, personKey1)
      expect('person' in result).toBe(true)
      if (!('person' in result)) return

      expect(result.refs).toHaveProperty('wiki:ai-infrastructure')
      expect(result.sections.map((s) => s.anchor)).toContain('background')
      expect(result.infobox).not.toBeNull()
      const labels = result.infobox?.rows.map((r) => r.label)
      expect(labels).toEqual(
        expect.arrayContaining(['Relationship', 'Aliases', 'First mentioned', 'Mentions'])
      )
    })
  })

  // ─── find_person routing ───

  describe('find_person routing', () => {
    it('detects lookupKey pattern correctly', () => {
      expect(/^person[0-9A-Z]{26}$/i.test('person01ABCDEFGHIJKLMNOPQRSTUVWX')).toBe(true)
      expect(/^person[0-9A-Z]{26}$/i.test('David Chen')).toBe(false)
      expect(/^person[0-9A-Z]{26}$/i.test('david-chen')).toBe(false)
    })
  })
})

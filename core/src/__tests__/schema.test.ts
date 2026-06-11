import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import type postgres from 'postgres'
import { makeLookupKey, ObjectType } from '@robin/shared'
import {
  entries,
  fragments,
  wikis,
  people,
  edges,
  users,
  sessions,
  accounts,
  verifications,
} from '../db/schema.js'
import { EdgeType } from '../db/edge-types.js'
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

describe.skipIf(!dbAvailable)('schema DB integration', () => {

let db: ReturnType<typeof getTestDb>['db']
let sqlConn: ReturnType<typeof postgres>
let testUserId: string
let testVaultId: string

beforeAll(async () => {
  await ensureTestDatabase()
  pushTestSchema()
  const conn = getTestDb()
  db = conn.db
  sqlConn = conn.sql
  testUserId = await createTestUser(db)
  testVaultId = await createTestVault(db)
}, 60_000)

afterAll(async () => {
  await cleanupTestDb(sqlConn)
})

afterEach(async () => {
  await clearTestData(db)
})

// ─── REQ-SCH-01: Domain tables with shared base columns ───

describe('REQ-SCH-01: domain tables with shared base columns', () => {
  it('inserts and queries an entry with all base + per-type columns', async () => {
    const key = makeLookupKey(ObjectType.ENTRY)
    await db.insert(entries).values({
      lookupKey: key,
      userId: testUserId,
      slug: 'test-entry',
      state: 'PENDING',
      repoPath: 'entries/test-entry.md',
      title: 'Test Entry',
      content: 'Hello world',
      type: 'thought',
      source: 'api',
      vaultId: testVaultId,
    })

    const [row] = await db.select().from(entries).where(eq(entries.lookupKey, key))

    expect(row).toBeDefined()
    expect(row.lookupKey).toBe(key)
    expect(row.userId).toBe(testUserId)
    expect(row.slug).toBe('test-entry')
    expect(row.state).toBe('PENDING')
    expect(row.repoPath).toBe('entries/test-entry.md')
    expect(row.title).toBe('Test Entry')
    expect(row.content).toBe('Hello world')
    expect(row.type).toBe('thought')
    expect(row.source).toBe('api')
    expect(row.vaultId).toBe(testVaultId)
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.updatedAt).toBeInstanceOf(Date)
    // Hash columns default to null
    expect(row.frontmatterHash).toBeNull()
    expect(row.bodyHash).toBeNull()
    expect(row.contentHash).toBeNull()
  })

  it('inserts and queries a fragment linked to entry', async () => {
    // Create parent entry first
    const entryKey = makeLookupKey(ObjectType.ENTRY)
    await db.insert(entries).values({
      lookupKey: entryKey,
      userId: testUserId,
      slug: 'parent-entry',
      title: 'Parent',
      content: '',
      vaultId: testVaultId,
    })

    const fragKey = makeLookupKey(ObjectType.FRAGMENT)
    await db.insert(fragments).values({
      lookupKey: fragKey,
      userId: testUserId,
      slug: 'test-fragment',
      title: 'Test Fragment',
      type: 'concept',
      tags: ['tag1', 'tag2'],
      entryId: entryKey,
    })

    const [row] = await db.select().from(fragments).where(eq(fragments.lookupKey, fragKey))

    expect(row).toBeDefined()
    expect(row.lookupKey).toBe(fragKey)
    expect(row.userId).toBe(testUserId)
    expect(row.slug).toBe('test-fragment')
    expect(row.state).toBe('PENDING')
    expect(row.title).toBe('Test Fragment')
    expect(row.type).toBe('concept')
    expect(row.tags).toEqual(['tag1', 'tag2'])
    expect(row.entryId).toBe(entryKey)
  })

  it('inserts and queries a thread', async () => {
    const key = makeLookupKey(ObjectType.THREAD)
    await db.insert(wikis).values({
      lookupKey: key,
      userId: testUserId,
      slug: 'test-thread',
      name: 'Test Thread',
      type: 'log',
      prompt: 'Collect daily reflections',
    })

    const [row] = await db.select().from(wikis).where(eq(wikis.lookupKey, key))

    expect(row).toBeDefined()
    expect(row.lookupKey).toBe(key)
    expect(row.userId).toBe(testUserId)
    expect(row.slug).toBe('test-thread')
    expect(row.state).toBe('PENDING')
    expect(row.name).toBe('Test Thread')
    expect(row.type).toBe('log')
    expect(row.prompt).toBe('Collect daily reflections')
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('inserts and queries a person with JSONB sections', async () => {
    const key = makeLookupKey(ObjectType.PERSON)
    const sections = {
      bio: 'A software engineer',
      notes: ['Met at conference', 'Works on AI'],
    }
    await db.insert(people).values({
      lookupKey: key,
      userId: testUserId,
      slug: 'test-person',
      name: 'Jane Doe',
      relationship: 'colleague',
      sections,
    })

    const [row] = await db.select().from(people).where(eq(people.lookupKey, key))

    expect(row).toBeDefined()
    expect(row.lookupKey).toBe(key)
    expect(row.name).toBe('Jane Doe')
    expect(row.relationship).toBe('colleague')
    expect(row.sections).toEqual(sections)
  })

  it('enforces objectStateEnum values', async () => {
    const key = makeLookupKey(ObjectType.THREAD)
    await expect(
      db.insert(wikis).values({
        lookupKey: key,
        userId: testUserId,
        slug: 'bad-state',
        name: 'Bad State',
        state: 'INVALID' as any,
      })
    ).rejects.toThrow()
  })

  it('accepts all valid objectStateEnum values', async () => {
    for (const state of ['PENDING', 'RESOLVED', 'LINKING', 'DIRTY'] as const) {
      const key = makeLookupKey(ObjectType.THREAD)
      await db.insert(wikis).values({
        lookupKey: key,
        userId: testUserId,
        slug: `state-${state.toLowerCase()}`,
        name: `State ${state}`,
        state,
      })
      const [row] = await db.select().from(wikis).where(eq(wikis.lookupKey, key))
      expect(row.state).toBe(state)
    }
  })

  it('enforces unique(userId, slug) per table', async () => {
    const key1 = makeLookupKey(ObjectType.THREAD)
    const key2 = makeLookupKey(ObjectType.THREAD)
    await db.insert(wikis).values({
      lookupKey: key1,
      userId: testUserId,
      slug: 'duplicate-slug',
      name: 'First',
    })
    await expect(
      db.insert(wikis).values({
        lookupKey: key2,
        userId: testUserId,
        slug: 'duplicate-slug',
        name: 'Second',
      })
    ).rejects.toThrow()
  })
})

// ─── REQ-SCH-02: Edges table with typed relationships ───

describe('REQ-SCH-02: edges table with typed relationships', () => {
  let entryKey: string
  let fragKey: string
  let wikiKey: string
  let personKey: string

  beforeAll(async () => {
    // These persist across tests in this describe block; afterEach clears them
  })

  async function createDomainObjects() {
    entryKey = makeLookupKey(ObjectType.ENTRY)
    fragKey = makeLookupKey(ObjectType.FRAGMENT)
    wikiKey = makeLookupKey(ObjectType.THREAD)
    personKey = makeLookupKey(ObjectType.PERSON)

    await db.insert(entries).values({
      lookupKey: entryKey,
      userId: testUserId,
      slug: `entry-${Date.now()}`,
      title: 'Edge Test Entry',
      content: '',
      vaultId: testVaultId,
    })
    await db.insert(fragments).values({
      lookupKey: fragKey,
      userId: testUserId,
      slug: `frag-${Date.now()}`,
      title: 'Edge Test Fragment',
      entryId: entryKey,
    })
    await db.insert(wikis).values({
      lookupKey: wikiKey,
      userId: testUserId,
      slug: `thread-${Date.now()}`,
      name: 'Edge Test Thread',
    })
    await db.insert(people).values({
      lookupKey: personKey,
      userId: testUserId,
      slug: `person-${Date.now()}`,
      name: 'Edge Test Person',
    })
  }

  it('creates ENTRY_HAS_FRAGMENT edge', async () => {
    await createDomainObjects()

    await db.insert(edges).values({
      id: crypto.randomUUID(),
      userId: testUserId,
      srcType: 'entry',
      srcId: entryKey,
      dstType: 'frag',
      dstId: fragKey,
      edgeType: 'ENTRY_HAS_FRAGMENT',
    })

    const [row] = await db.select().from(edges).where(eq(edges.edgeType, 'ENTRY_HAS_FRAGMENT'))

    expect(row).toBeDefined()
    expect(row.srcId).toBe(entryKey)
    expect(row.dstId).toBe(fragKey)
    expect(row.edgeType).toBe('ENTRY_HAS_FRAGMENT')
  })

  it('creates all 5 edge types', async () => {
    await createDomainObjects()

    const frag2Key = makeLookupKey(ObjectType.FRAGMENT)
    await db.insert(fragments).values({
      lookupKey: frag2Key,
      userId: testUserId,
      slug: `frag2-${Date.now()}`,
      title: 'Second Fragment',
      entryId: entryKey,
    })

    const edgeData = [
      {
        srcType: 'entry',
        srcId: entryKey,
        dstType: 'frag',
        dstId: fragKey,
        edgeType: 'ENTRY_HAS_FRAGMENT' as const,
      },
      {
        srcType: 'frag',
        srcId: fragKey,
        dstType: 'wiki',
        dstId: wikiKey,
        edgeType: 'FRAGMENT_IN_WIKI' as const,
      },
      {
        srcType: 'frag',
        srcId: fragKey,
        dstType: 'person',
        dstId: personKey,
        edgeType: 'FRAGMENT_MENTIONS_PERSON' as const,
      },
      {
        srcType: 'frag',
        srcId: fragKey,
        dstType: 'frag',
        dstId: frag2Key,
        edgeType: 'FRAGMENT_RELATED_TO_FRAGMENT' as const,
      },
      {
        srcType: 'entry',
        srcId: entryKey,
        dstType: 'vault',
        dstId: testVaultId,
        edgeType: 'ENTRY_IN_VAULT' as const,
      },
    ]

    for (const edge of edgeData) {
      await db.insert(edges).values({
        id: crypto.randomUUID(),
        userId: testUserId,
        ...edge,
      })
    }

    const allEdges = await db.select().from(edges)
    expect(allEdges).toHaveLength(5)

    const types = allEdges.map((e) => e.edgeType).sort()
    expect(types).toEqual([
      'ENTRY_HAS_FRAGMENT',
      'ENTRY_IN_VAULT',
      'FRAGMENT_IN_WIKI',
      'FRAGMENT_MENTIONS_PERSON',
      'FRAGMENT_RELATED_TO_FRAGMENT',
    ])
  })

  it('prevents duplicate edges via unique constraint', async () => {
    await createDomainObjects()

    const edgeValues = {
      userId: testUserId,
      srcType: 'entry',
      srcId: entryKey,
      dstType: 'frag',
      dstId: fragKey,
      edgeType: 'ENTRY_HAS_FRAGMENT',
    }

    await db.insert(edges).values({ id: crypto.randomUUID(), ...edgeValues })

    await expect(
      db.insert(edges).values({ id: crypto.randomUUID(), ...edgeValues })
    ).rejects.toThrow()
  })

  it('stores and retrieves JSONB attrs', async () => {
    await createDomainObjects()

    const attrs = { weight: 0.95, source: 'ai-pipeline', tags: ['auto'] }
    await db.insert(edges).values({
      id: crypto.randomUUID(),
      userId: testUserId,
      srcType: 'entry',
      srcId: entryKey,
      dstType: 'frag',
      dstId: fragKey,
      edgeType: 'ENTRY_HAS_FRAGMENT',
      attrs,
    })

    const [row] = await db.select().from(edges).where(eq(edges.edgeType, 'ENTRY_HAS_FRAGMENT'))

    expect(row.attrs).toEqual(attrs)
  })

  it('queries edges by src (forward traversal)', async () => {
    await createDomainObjects()

    const frag2Key = makeLookupKey(ObjectType.FRAGMENT)
    await db.insert(fragments).values({
      lookupKey: frag2Key,
      userId: testUserId,
      slug: `frag-fwd-${Date.now()}`,
      title: 'Forward Fragment',
      entryId: entryKey,
    })

    await db.insert(edges).values([
      {
        id: crypto.randomUUID(),
        userId: testUserId,
        srcType: 'entry',
        srcId: entryKey,
        dstType: 'frag',
        dstId: fragKey,
        edgeType: 'ENTRY_HAS_FRAGMENT',
      },
      {
        id: crypto.randomUUID(),
        userId: testUserId,
        srcType: 'entry',
        srcId: entryKey,
        dstType: 'frag',
        dstId: frag2Key,
        edgeType: 'ENTRY_HAS_FRAGMENT',
      },
    ])

    const forwardEdges = await db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.srcType, 'entry'),
          eq(edges.srcId, entryKey),
          eq(edges.edgeType, 'ENTRY_HAS_FRAGMENT')
        )
      )

    expect(forwardEdges).toHaveLength(2)
  })

  it('queries edges by dst (reverse traversal)', async () => {
    await createDomainObjects()

    await db.insert(edges).values({
      id: crypto.randomUUID(),
      userId: testUserId,
      srcType: 'entry',
      srcId: entryKey,
      dstType: 'frag',
      dstId: fragKey,
      edgeType: 'ENTRY_HAS_FRAGMENT',
    })

    const reverseEdges = await db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.dstType, 'frag'),
          eq(edges.dstId, fragKey),
          eq(edges.edgeType, 'ENTRY_HAS_FRAGMENT')
        )
      )

    expect(reverseEdges).toHaveLength(1)
    expect(reverseEdges[0].srcId).toBe(entryKey)
  })
})

// ─── REQ-SCH-03: Old tables dropped ───

describe('REQ-SCH-03: old tables dropped', () => {
  async function tableExists(tableName: string): Promise<boolean> {
    const result = await db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ${tableName}`
    )
    return result.length > 0
  }

  it('files table does not exist', async () => {
    expect(await tableExists('files')).toBe(false)
  })

  it('folders table does not exist', async () => {
    expect(await tableExists('folders')).toBe(false)
  })

  it('connections table does not exist', async () => {
    expect(await tableExists('connections')).toBe(false)
  })

  it('fragment_people table does not exist', async () => {
    expect(await tableExists('fragment_people')).toBe(false)
  })
})

// ─── REQ-SCH-04: Auth tables preserved ───

describe('REQ-SCH-04: auth tables preserved', () => {
  async function getColumnNames(tableName: string): Promise<string[]> {
    const result = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${tableName} ORDER BY ordinal_position`
    )
    return result.map((r: any) => r.column_name)
  }

  it('users table exists with expected columns', async () => {
    const cols = await getColumnNames('users')
    expect(cols).toContain('id')
    expect(cols).toContain('email')
    expect(cols).toContain('email_verified')
    expect(cols).toContain('name')
    expect(cols).toContain('image')
    expect(cols).toContain('created_at')
    expect(cols).toContain('updated_at')
  })

  it('sessions table exists with expected columns', async () => {
    const cols = await getColumnNames('sessions')
    expect(cols).toContain('id')
    expect(cols).toContain('user_id')
    expect(cols).toContain('token')
    expect(cols).toContain('expires_at')
    expect(cols).toContain('ip_address')
    expect(cols).toContain('user_agent')
  })

  it('accounts table exists with expected columns', async () => {
    const cols = await getColumnNames('accounts')
    expect(cols).toContain('id')
    expect(cols).toContain('user_id')
    expect(cols).toContain('account_id')
    expect(cols).toContain('provider_id')
    expect(cols).toContain('access_token')
    expect(cols).toContain('password')
  })

  it('verifications table exists with expected columns', async () => {
    const cols = await getColumnNames('verifications')
    expect(cols).toContain('id')
    expect(cols).toContain('identifier')
    expect(cols).toContain('value')
    expect(cols).toContain('expires_at')
  })
})

}) // end describe.skipIf(!dbAvailable)

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { handleLogFragment, type McpServerDeps } from '../mcp/handlers.js'
import {
  fragments as fragmentsTable,
  wikis as wikisTable,
  edges as edgesTable,
  people as peopleTable,
} from '../db/schema.js'
import {
  ensureTestDatabase,
  pushTestSchema,
  getTestDb,
  cleanupTestDb,
  createTestUser,
  createTestVault,
  clearTestData,
} from './test-setup.js'
import type postgres from 'postgres'

// ─── Test Setup ───

let db: ReturnType<typeof getTestDb>['db']
let sqlConn: ReturnType<typeof postgres>
let testUserId: string
let testVaultId: string

const TEST_WIKI_KEY = 'thread01TESTTHREAD000000000001'
const TEST_WIKI_SLUG = 'fitness'

function makeDeps(overrides: Partial<McpServerDeps> = {}): McpServerDeps {
  return {
    db,
    producer: {
      enqueueExtraction: vi.fn().mockResolvedValue('job-id'),
      enqueueLink: vi.fn(),
      enqueueReclassify: vi.fn(),
      enqueueProvision: vi.fn(),
      getQueue: vi.fn(),
      close: vi.fn(),
    } as unknown as McpServerDeps['producer'],
    spawnWriteWorker: vi.fn(),
    resolveDefaultVaultId: vi.fn().mockResolvedValue(testVaultId),
    entityExtractCall: vi.fn().mockResolvedValue({ people: [] }),
    loadUserPeople: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

async function createTestWiki() {
  await db
    .insert(wikisTable)
    .values({
      lookupKey: TEST_WIKI_KEY,
      slug: TEST_WIKI_SLUG,
      name: 'Fitness',
      type: 'log',
      state: 'RESOLVED',
      vaultId: testVaultId,
    })
    .onConflictDoNothing()
}

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

beforeEach(async () => {
  await clearTestData(db)
  await createTestWiki()
})

// ─── Tests ───

describe('handleLogFragment', () => {
  it('inserts fragment in RESOLVED state with correct fields', async () => {
    const deps = makeDeps()
    const result = await handleLogFragment(
      deps,
      { content: 'Did a 5k run today', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.fragmentKey).toMatch(/^frag/)
    expect(parsed.threadSlug).toBe(TEST_WIKI_SLUG)
    expect(parsed.wikiKey).toBe(TEST_WIKI_KEY)

    const rows = await db.select().from(fragmentsTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('RESOLVED')
    expect(rows[0].type).toBe('observation')
    expect(rows[0].title).toBe('Did a 5k run today')
    expect(rows[0].entryId).toBeNull()
  })

  it('stores fragment content in DB', async () => {
    const deps = makeDeps()
    await handleLogFragment(
      deps,
      { content: 'Morning run notes', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    const rows = await db.select().from(fragmentsTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain('Morning run notes')
  })

  it('inserts FRAGMENT_IN_WIKI edge', async () => {
    const deps = makeDeps()
    const result = await handleLogFragment(
      deps,
      { content: 'Leg day', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    const parsed = JSON.parse(result.content[0].text)
    const edgeRows = await db
      .select()
      .from(edgesTable)
      .where(eq(edgesTable.srcId, parsed.fragmentKey))
    expect(edgeRows).toHaveLength(1)
    expect(edgeRows[0].edgeType).toBe('FRAGMENT_IN_WIKI')
    expect(edgeRows[0].dstId).toBe(TEST_WIKI_KEY)
  })

  it('marks wiki PENDING after fragment insert', async () => {
    const deps = makeDeps()
    await handleLogFragment(
      deps,
      { content: 'Recovery session', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    const [wiki] = await db
      .select()
      .from(wikisTable)
      .where(eq(wikisTable.lookupKey, TEST_WIKI_KEY))
    expect(wiki.state).toBe('PENDING')
  })

  it('uses provided title when given', async () => {
    const deps = makeDeps()
    await handleLogFragment(
      deps,
      {
        content: 'Details here',
        threadSlug: TEST_WIKI_SLUG,
        title: 'Custom Title',
      },
      testUserId
    )

    const rows = await db.select().from(fragmentsTable)
    expect(rows[0].title).toBe('Custom Title')
  })

  it('derives title from first 80 chars when not provided', async () => {
    const deps = makeDeps()
    const longContent = `${'A'.repeat(100)} trailing`
    await handleLogFragment(
      deps,
      { content: longContent, threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    const rows = await db.select().from(fragmentsTable)
    expect(rows[0].title).toBe('A'.repeat(80))
  })

  it('persists tags on fragment row', async () => {
    const deps = makeDeps()
    await handleLogFragment(
      deps,
      {
        content: 'Tagged note',
        threadSlug: TEST_WIKI_SLUG,
        tags: ['fitness', 'running'],
      },
      testUserId
    )

    const rows = await db.select().from(fragmentsTable)
    expect(rows[0].tags).toEqual(['fitness', 'running'])
  })

  it('inserts FRAGMENT_MENTIONS_PERSON edges when entity extraction finds people', async () => {
    const personKey = 'person01TESTPERSON00000000001'
    const deps = makeDeps({
      loadUserPeople: vi
        .fn()
        .mockResolvedValue([{ lookupKey: personKey, canonicalName: 'Marcus', aliases: [] }]),
      entityExtractCall: vi.fn().mockResolvedValue({
        people: [
          {
            mention: 'Marcus',
            inferredName: 'Marcus',
            matchedKey: personKey,
            confidence: 0.95,
            sourceSpan: 'Marcus helped with form',
          },
        ],
      }),
    })

    const result = await handleLogFragment(
      deps,
      { content: 'Marcus helped with form', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    const parsed = JSON.parse(result.content[0].text)
    const edgeRows = await db
      .select()
      .from(edgesTable)
      .where(eq(edgesTable.srcId, parsed.fragmentKey))
    const personEdge = edgeRows.find((e) => e.edgeType === 'FRAGMENT_MENTIONS_PERSON')
    expect(personEdge).toBeDefined()
    expect(personEdge?.dstId).toBe(personKey)
    // H2 (#329): every FRAGMENT_MENTIONS_PERSON write stamps the
    // mention surface form, source span, and extractor confidence.
    expect(personEdge?.attrs).toMatchObject({
      mention: 'Marcus',
      sourceSpan: 'Marcus helped with form',
      confidence: 0.95,
    })
  })

  it('proceeds when entity extraction throws (fail-open)', async () => {
    const deps = makeDeps({
      entityExtractCall: vi.fn().mockRejectedValue(new Error('LLM down')),
    })

    const result = await handleLogFragment(
      deps,
      { content: 'Still works', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    expect(result.isError).toBeUndefined()
    const rows = await db.select().from(fragmentsTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('RESOLVED')
  })

  it('returns error when threadSlug not found', async () => {
    const deps = makeDeps()
    const result = await handleLogFragment(
      deps,
      { content: 'Lost fragment', threadSlug: 'nonexistent-thread' },
      testUserId
    )

    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('nonexistent-thread')
    expect(parsed.suggestions).toBeDefined()
  })

  it('returns error when userId is undefined', async () => {
    const deps = makeDeps()
    const result = await handleLogFragment(
      deps,
      { content: 'Hello', threadSlug: TEST_WIKI_SLUG },
      undefined
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not authenticated')
  })

  it('returns error when content is empty', async () => {
    const deps = makeDeps()
    const result = await handleLogFragment(
      deps,
      { content: '', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('content is required')
  })

  it('returns error when threadSlug is empty', async () => {
    const deps = makeDeps()
    const result = await handleLogFragment(
      deps,
      { content: 'Some content', threadSlug: '' },
      testUserId
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('threadSlug is required')
  })

  it('inserts new person rows when entity extraction finds unknown people', async () => {
    const deps = makeDeps({
      entityExtractCall: vi.fn().mockResolvedValue({
        people: [{ mention: 'Sarah', inferredName: 'Sarah Connor' }],
      }),
    })

    const result = await handleLogFragment(
      deps,
      { content: 'Trained with Sarah', threadSlug: TEST_WIKI_SLUG },
      testUserId
    )

    expect(result.isError).toBeUndefined()
    const personRows = await db.select().from(peopleTable)
    expect(personRows).toHaveLength(1)
    expect(personRows[0].name).toBe('Sarah Connor')
    expect(personRows[0].state).toBe('RESOLVED')
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// handlers.js → openrouter-config.js → db/client.ts throws when DATABASE_URL
// is absent. The handlers use DI (deps.db), not the global db singleton, so
// a stub here has no effect on the real DB queries in this test.
vi.mock('../db/client.js', () => ({ db: {} }))

import { handleLogEntry, type McpServerDeps } from '../mcp/handlers.js'
import { entries as entriesTable, vaults } from '../db/schema.js'
import type { ExtractionJob } from '@robin/queue'
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
import type postgres from 'postgres'

const dbAvailable = await canConnectToTestDb()

describe.skipIf(!dbAvailable)('handleLogEntry DB integration', () => {

// ─── Test Setup ───

let db: ReturnType<typeof getTestDb>['db']
let sqlConn: ReturnType<typeof postgres>
let testUserId: string
let testVaultId: string

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
})

// ─── Tests ───

describe('handleLogEntry', () => {
  it('inserts entry row in PENDING state before enqueuing extraction job', async () => {
    const deps = makeDeps()
    const result = await handleLogEntry(deps, { content: 'Hello world' }, testUserId)

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Entry queued: entry')

    // Verify entry row exists in DB
    const rows = await db.select().from(entriesTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('PENDING')
    expect(rows[0].content).toBe('Hello world')
    expect(rows[0].source).toBe('mcp')
    expect(rows[0].type).toBe('thought')
    expect(rows[0].title).toBe('Hello world')
    expect(rows[0].vaultId).toBe(testVaultId)

    // Verify enqueue was called after insert
    expect(deps.producer.enqueueExtraction).toHaveBeenCalledTimes(1)
    const job = (deps.producer.enqueueExtraction as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as ExtractionJob
    expect(job.entryKey).toBe(rows[0].lookupKey)
    expect(job.content).toBe('Hello world')
    expect(job.source).toBe('mcp')
  })

  it('stores content in DB entry row', async () => {
    const deps = makeDeps()
    await handleLogEntry(deps, { content: 'My note content' }, testUserId)

    const rows = await db.select().from(entriesTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('My note content')
  })

  it('sets title from first 80 chars of content', async () => {
    const longContent = `${'A'.repeat(100)} trailing text`
    const deps = makeDeps()
    await handleLogEntry(deps, { content: longContent }, testUserId)

    const rows = await db.select().from(entriesTable)
    expect(rows[0].title).toBe('A'.repeat(80))
  })

  it('trims whitespace from content', async () => {
    const deps = makeDeps()
    await handleLogEntry(deps, { content: '  spaced content  ' }, testUserId)

    const rows = await db.select().from(entriesTable)
    expect(rows[0].content).toBe('spaced content')
  })

  it('returns error for empty content', async () => {
    const deps = makeDeps()
    const result = await handleLogEntry(deps, { content: '' }, testUserId)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('content is required')
    expect(deps.producer.enqueueExtraction).not.toHaveBeenCalled()
  })

  it('returns error for whitespace-only content', async () => {
    const deps = makeDeps()
    const result = await handleLogEntry(deps, { content: '   \n\t  ' }, testUserId)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('content is required')
  })

  it('returns error when userId is undefined', async () => {
    const deps = makeDeps()
    const result = await handleLogEntry(deps, { content: 'Hello' }, undefined)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not authenticated')
    expect(deps.producer.enqueueExtraction).not.toHaveBeenCalled()
  })

  it('respects source parameter override', async () => {
    const deps = makeDeps()
    await handleLogEntry(deps, { content: 'From web', source: 'web' }, testUserId)

    const rows = await db.select().from(entriesTable)
    expect(rows[0].source).toBe('web')

    const job = (deps.producer.enqueueExtraction as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as ExtractionJob
    expect(job.source).toBe('web')
  })

  it('defaults source to mcp when not specified', async () => {
    const deps = makeDeps()
    await handleLogEntry(deps, { content: 'No source' }, testUserId)

    const rows = await db.select().from(entriesTable)
    expect(rows[0].source).toBe('mcp')
  })

  it('sets vaultId to null when no default vault exists', async () => {
    const deps = makeDeps({
      resolveDefaultVaultId: vi.fn().mockResolvedValue(null),
    })
    await handleLogEntry(deps, { content: 'No vault' }, testUserId)

    const rows = await db.select().from(entriesTable)
    expect(rows[0].vaultId).toBeNull()
  })

  it('spawns write worker for the user', async () => {
    const deps = makeDeps()
    await handleLogEntry(deps, { content: 'Hello' }, testUserId)

    expect(deps.spawnWriteWorker).toHaveBeenCalledWith(testUserId)
  })

  it('disambiguates slug when a collision exists', async () => {
    // Insert an entry that will claim the slug 'hello'
    await db.insert(entriesTable).values({
      lookupKey: 'conflict-key',
      slug: 'hello',
      title: 'Hello',
      content: 'Hello',
      type: 'thought',
      source: 'mcp',
    })

    // A second entry with the same content should get slug 'hello-2'
    const deps = makeDeps()
    const result = await handleLogEntry(deps, { content: 'Hello' }, testUserId)

    expect(result.isError).toBeUndefined()

    const rows = await db.select().from(entriesTable)
    const slugs = rows.map((r) => r.slug).sort()
    expect(slugs).toContain('hello')
    expect(slugs).toContain('hello-2')
  })
})

}) // end describe.skipIf(!dbAvailable)

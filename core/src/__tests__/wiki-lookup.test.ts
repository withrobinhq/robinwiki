import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type postgres from 'postgres'
import { wikis, people, fragments, entries, users } from '../db/schema.js'
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
import { createWikiLookupFn } from '../lib/wiki-lookup.js'

const dbAvailable = await canConnectToTestDb()

describe.skipIf(!dbAvailable)('Wiki Lookup (LINK-01)', () => {

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

describe('createWikiLookupFn', () => {
    it('returns matching thread by slug and userId', async () => {
      await db.insert(wikis).values({
        id: 'thread-001',
        userId: testUserId,
        lookupKey: 'thread-abc123',
        name: 'My Thread',
        slug: 'my-thread',
        type: 'log',
        repoPath: 'wikis/my-thread.md',
      })

      const lookup = createWikiLookupFn(testUserId, db)
      const result = await lookup('my-thread', 'wiki')
      expect(result).toEqual({ type: 'wiki', key: 'thread-abc123' })
    })

    it('returns null when no match found', async () => {
      const lookup = createWikiLookupFn(testUserId, db)
      const result = await lookup('nonexistent', 'wiki')
      expect(result).toBeNull()
    })

    it('ignores deleted objects (deletedAt is set)', async () => {
      await db.insert(people).values({
        id: 'person-del-001',
        userId: testUserId,
        lookupKey: 'person-deleted',
        name: 'Deleted Person',
        slug: 'deleted-person',
        repoPath: 'people/deleted-person.md',
        deletedAt: new Date(),
      })

      const lookup = createWikiLookupFn(testUserId, db)
      const result = await lookup('deleted-person', 'person')
      expect(result).toBeNull()
    })

    it('resolves qualified lookup (with type hint) to correct table', async () => {
      await db.insert(people).values({
        id: 'person-001',
        userId: testUserId,
        lookupKey: 'person-xyz',
        name: 'John Doe',
        slug: 'john-doe',
        repoPath: 'people/john-doe.md',
      })

      const lookup = createWikiLookupFn(testUserId, db)
      const result = await lookup('john-doe', 'person')
      expect(result).toEqual({ type: 'person', key: 'person-xyz' })
    })

    it('resolves unqualified lookup in priority order: thread > person > fragment > entry', async () => {
      // Insert same slug in person and fragment tables — person should win
      await db.insert(entries).values({
        id: 'entry-for-frag',
        userId: testUserId,
        lookupKey: 'entry-for-frag',
        slug: 'entry-for-frag',
        vaultId: testVaultId,
        repoPath: 'entries/e.md',
      })

      await db.insert(people).values({
        id: 'person-shared',
        userId: testUserId,
        lookupKey: 'person-shared-key',
        name: 'Shared Slug',
        slug: 'shared-slug',
        repoPath: 'people/shared-slug.md',
      })

      await db.insert(fragments).values({
        id: 'frag-shared',
        userId: testUserId,
        lookupKey: 'frag-shared-key',
        title: 'Shared Slug',
        slug: 'shared-slug',
        entryId: 'entry-for-frag',
        repoPath: 'fragments/shared-slug.md',
      })

      const lookup = createWikiLookupFn(testUserId, db)
      const result = await lookup('shared-slug')
      // Person has higher priority than fragment
      expect(result).toEqual({ type: 'person', key: 'person-shared-key' })
    })

    it('returns null for unknown type hint', async () => {
      const lookup = createWikiLookupFn(testUserId, db)
      const result = await lookup('slug', 'unknown-type')
      expect(result).toBeNull()
    })

    it('does not return objects belonging to a different user', async () => {
      const otherUserId = 'test-user-other'
      await db
        .insert(users)
        .values({
          id: otherUserId,
          email: 'other@robin.test',
          name: 'Other User',
        })
        .onConflictDoNothing()

      await db.insert(wikis).values({
        id: 'thread-other',
        userId: otherUserId,
        lookupKey: 'thread-other-key',
        name: 'Other Thread',
        slug: 'other-thread',
        type: 'log',
        repoPath: 'wikis/other-thread.md',
      })

      const lookup = createWikiLookupFn(testUserId, db)
      const result = await lookup('other-thread', 'wiki')
      expect(result).toBeNull()
    })
  })
})

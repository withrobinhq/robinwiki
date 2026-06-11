import { drizzle } from 'drizzle-orm/postgres-js'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'
import * as schema from '../db/schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_ROOT = resolve(__dirname, '../..')

export const TEST_DB_URL = 'postgresql://robin:@localhost:5432/robin_test'
const ADMIN_DB_URL = 'postgresql://robin:@localhost:5432/robin_dev'

/**
 * Returns true if the test database is reachable (used with describe.skipIf).
 * Performs a single lightweight connection attempt with a 3-second timeout so
 * CI without Postgres skips DB-integration suites cleanly instead of failing.
 */
export async function canConnectToTestDb(): Promise<boolean> {
  const sql = postgres(TEST_DB_URL, { max: 1, connect_timeout: 3, idle_timeout: 1 })
  try {
    await sql`SELECT 1`
    return true
  } catch {
    return false
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {})
  }
}

/**
 * Creates the robin_test database if it doesn't already exist.
 * Connects to robin_dev to run admin commands.
 */
export async function ensureTestDatabase(): Promise<void> {
  const adminSql = postgres(ADMIN_DB_URL, { max: 1 })
  try {
    const result = await adminSql`SELECT 1 FROM pg_database WHERE datname = 'robin_test'`
    if (result.length === 0) {
      // postgres.js doesn't support CREATE DATABASE in template strings easily,
      // so we use unsafe for DDL
      await adminSql.unsafe('CREATE DATABASE robin_test')
    }
  } finally {
    await adminSql.end()
  }
}

/**
 * Pushes the current Drizzle schema to robin_test using drizzle-kit push.
 */
export function pushTestSchema(): void {
  execSync(`DATABASE_URL=${TEST_DB_URL} npx drizzle-kit push --force`, {
    cwd: SERVER_ROOT,
    stdio: 'pipe',
    timeout: 30_000,
  })
}

/**
 * Returns a Drizzle client connected to the robin_test database.
 */
export function getTestDb() {
  const sql = postgres(TEST_DB_URL, { max: 5 })
  const db = drizzle(sql, { schema })
  return { db, sql }
}

/**
 * Closes the database connection.
 */
export async function cleanupTestDb(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.end()
}

const TEST_USER_ID = 'test-user-001'

/**
 * Inserts a minimal test user and returns the user id.
 * If user already exists, returns the id without error.
 */
export async function createTestUser(
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<string> {
  await db
    .insert(schema.users)
    .values({
      id: TEST_USER_ID,
      email: 'test@robin.test',
      name: 'Test User',
    })
    .onConflictDoNothing()
  return TEST_USER_ID
}

const TEST_VAULT_ID = 'test-vault-001'

/**
 * Inserts a minimal test vault for FK references from entries.
 */
export async function createTestVault(
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<string> {
  await db
    .insert(schema.vaults)
    .values({
      id: TEST_VAULT_ID,
      name: 'Test Vault',
      slug: 'test-vault',
    })
    .onConflictDoNothing()
  return TEST_VAULT_ID
}

/**
 * Truncates all domain tables + edges in correct FK order.
 * Does NOT touch auth tables (users, sessions, accounts, verifications).
 */
export async function clearTestData(db: ReturnType<typeof drizzle<typeof schema>>): Promise<void> {
  // Order matters: edges first, then fragments (FK to entries), then the rest
  await db.delete(schema.edges)
  await db.delete(schema.fragments)
  await db.delete(schema.entries)
  await db.delete(schema.wikis)
  await db.delete(schema.people)
}

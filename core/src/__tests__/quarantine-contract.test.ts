/**
 * Stream P (#PEOPLE-EXTRACT-Q) — quarantine contract test.
 *
 * Asserts the read-site exclusion matrix locked 2026-05-09 by inspecting
 * the source files directly (no DB roundtrip needed). Each section
 * pins one promise of the matrix to a code-side check that breaks
 * loudly if a future refactor regresses the behaviour.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

describe('quarantine contract — read-site exclusion matrix', () => {
  it('hybrid search filters person rows to status=verified', () => {
    const search = read('lib/search.ts')
    expect(search).toMatch(/personStatusFilter/)
    expect(search).toMatch(/people\.status.+= 'verified'/s)
  })

  it('embedding-retry-worker skips pending persons', () => {
    const worker = read('queue/embedding-retry-worker.ts')
    expect(worker).toMatch(/people\.status.+= 'verified'/)
  })

  it('GET /people defaults to status=verified', () => {
    const peopleRoute = read('routes/people.ts')
    expect(peopleRoute).toMatch(/statusFilter\s*=\s*c\.req\.query\('status'\)\s*\?\?\s*'verified'/)
  })

  it('find_person / findPersonById return status field on the person payload', () => {
    const resolvers = read('mcp/resolvers.ts')
    // The PersonDetail interface carries a status field
    expect(resolvers).toMatch(/status:\s*'verified'\s*\|\s*'pending'\s*\|\s*'rejected'/)
  })

  it('brief_person surfaces a quarantine notice for pending persons', () => {
    const resolvers = read('mcp/resolvers.ts')
    expect(resolvers).toMatch(/Quarantine: this person is awaiting operator approval/)
  })

  it('wikis read endpoint carries person status through aggregated edges', () => {
    const wikis = read('routes/wikis.ts')
    expect(wikis).toMatch(/status: people\.status/)
  })

  it('list_pending_persons exists and is read-only', () => {
    const handlers = read('mcp/handlers.ts')
    expect(handlers).toMatch(/handleListPendingPersons/)
    expect(handlers).not.toMatch(/handleApprovePending\b/)
    expect(handlers).not.toMatch(/handleRejectPending\b/)
  })

  it('does not register approve/reject MCP tools (HTTP-only by design)', () => {
    const server = read('mcp/server.ts')
    expect(server).not.toMatch(/'approve_pending_person'/)
    expect(server).not.toMatch(/'reject_pending_person'/)
  })
})

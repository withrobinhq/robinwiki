/**
 * @module scripts/generate-openapi-manifest
 *
 * @summary Extracts all Zod schemas into JSON Schema and maps them to
 * HTTP routes. Outputs a single manifest JSON consumed by /apidoc.
 *
 * @remarks
 * Run: `pnpm --filter @robin/core openapi:manifest`
 * Output: `core/openapi-manifest.json`
 */

import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ZodType } from 'zod'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  // base
  errorResponseSchema,
  okResponseSchema,
  queuedResponseSchema,
  // entries
  createEntryBodySchema,
  entryListQuerySchema,
  entryResponseSchema,
  entryCreatedResponseSchema,
  entryListResponseSchema,
  // fragments
  createFragmentBodySchema,
  updateFragmentBodySchema,
  fragmentListQuerySchema,
  fragmentResponseSchema,
  fragmentWithContentResponseSchema,
  fragmentDetailResponseSchema,
  fragmentListResponseSchema,
  fragmentReviewBodySchema,
  // wikis
  createWikiBodySchema,
  updateWikiBodySchema,
  wikiResponseSchema,
  wikiWithContentResponseSchema,
  wikiListResponseSchema,
  wikiDetailResponseSchema,
  bouncerModeBodySchema,
  bouncerModeResponseSchema,
  publishWikiResponseSchema,
  publicWikiResponseSchema,
  autoRegenBodySchema,
  autoRegenResponseSchema,
  editorialStateSchema,
  updateProgressBodySchema,
  updateProgressResponseSchema,
  // wiki types
  wikiTypeResponseSchema,
  wikiTypeListResponseSchema,
  createWikiTypeBodySchema,
  updateWikiTypeBodySchema,
  // people
  personResponseSchema,
  personDetailResponseSchema,
  personWithBacklinksResponseSchema,
  personListResponseSchema,
  updatePersonBodySchema,
  personListQuerySchema,
  // search
  searchQuerySchema,
  searchResponseSchema,
  // users
  userProfileResponseSchema,
  userStatsResponseSchema,
  userActivityResponseSchema,
  keypairResponseSchema,
  keypairRevealRequestSchema,
  keypairRevealResponseSchema,
  mcpEndpointResponseSchema,
  exportDataResponseSchema,
  // graph
  graphResponseSchema,
  // relationships
  relationshipsResponseSchema,
  // content
  contentRawResponseSchema,
  contentStructuredResponseSchema,
  // admin
  retryStuckDryRunResponseSchema,
  retryStuckResponseSchema,
  // audit
  auditLogResponseSchema,
  auditLogQuerySchema,
  auditEventSchema,
  timelineQuerySchema,
  // wiki edit history
  editRecordSchema,
  editHistoryResponseSchema,
  // system
  systemStatusResponseSchema,
} from '../src/schemas/index.js'

// ── Schema registry ─────────────────────────────────────────────────────────

const schemaRegistry: Record<string, ZodType> = {
  // base
  errorResponseSchema,
  okResponseSchema,
  queuedResponseSchema,
  // entries
  createEntryBodySchema,
  entryListQuerySchema,
  entryResponseSchema,
  entryCreatedResponseSchema,
  entryListResponseSchema,
  // fragments
  createFragmentBodySchema,
  updateFragmentBodySchema,
  fragmentListQuerySchema,
  fragmentResponseSchema,
  fragmentWithContentResponseSchema,
  fragmentDetailResponseSchema,
  fragmentListResponseSchema,
  fragmentReviewBodySchema,
  // wikis
  createWikiBodySchema,
  updateWikiBodySchema,
  wikiResponseSchema,
  wikiWithContentResponseSchema,
  wikiListResponseSchema,
  wikiDetailResponseSchema,
  bouncerModeBodySchema,
  bouncerModeResponseSchema,
  publishWikiResponseSchema,
  publicWikiResponseSchema,
  autoRegenBodySchema,
  autoRegenResponseSchema,
  editorialStateSchema,
  updateProgressBodySchema,
  updateProgressResponseSchema,
  // wiki types
  wikiTypeResponseSchema,
  wikiTypeListResponseSchema,
  createWikiTypeBodySchema,
  updateWikiTypeBodySchema,
  // people
  personResponseSchema,
  personDetailResponseSchema,
  personWithBacklinksResponseSchema,
  personListResponseSchema,
  updatePersonBodySchema,
  personListQuerySchema,
  // search
  searchQuerySchema,
  searchResponseSchema,
  // users
  userProfileResponseSchema,
  userStatsResponseSchema,
  userActivityResponseSchema,
  keypairResponseSchema,
  keypairRevealRequestSchema,
  keypairRevealResponseSchema,
  mcpEndpointResponseSchema,
  exportDataResponseSchema,
  // graph
  graphResponseSchema,
  // relationships
  relationshipsResponseSchema,
  // content
  contentRawResponseSchema,
  contentStructuredResponseSchema,
  // admin
  retryStuckDryRunResponseSchema,
  retryStuckResponseSchema,
  // audit
  auditLogResponseSchema,
  auditLogQuerySchema,
  auditEventSchema,
  timelineQuerySchema,
  // wiki edit history
  editRecordSchema,
  editHistoryResponseSchema,
  // system
  systemStatusResponseSchema,
}

// ── Route definitions ───────────────────────────────────────────────────────

interface RouteSpec {
  method: string
  path: string
  operationId: string
  summary: string
  tags: string[]
  auth: 'session' | 'hmac' | 'jwt' | 'none'
  request?: {
    body?: { schemaName: string }
    query?: { schemaName: string }
    params?: Record<string, string>
  }
  responses: Record<string, { description: string; schemaName?: string }>
}

const routes: RouteSpec[] = [
  // ── System ───────────────────────────────────────────────────────────────
  { method: 'GET', path: '/health', operationId: 'getHealth', summary: 'Health check', tags: ['System'], auth: 'none', responses: { '200': { description: 'Server is running' } } },
  { method: 'GET', path: '/openapi.json', operationId: 'getOpenApiSpec', summary: 'OpenAPI specification', tags: ['System'], auth: 'none', responses: { '200': { description: 'The OpenAPI spec' } } },
  { method: 'GET', path: '/system/status', operationId: 'getSystemStatus', summary: 'Get instance setup state (no auth)', tags: ['System'], auth: 'none', responses: { '200': { description: 'Instance status', schemaName: 'systemStatusResponseSchema' } } },

  // ── Entries ──────────────────────────────────────────────────────────────
  { method: 'POST', path: '/entries', operationId: 'createEntry', summary: 'Create a new entry (queues async processing)', tags: ['Entries'], auth: 'session', request: { body: { schemaName: 'createEntryBodySchema' } }, responses: { '202': { description: 'Entry created and queued', schemaName: 'entryCreatedResponseSchema' }, '400': { description: 'Invalid input', schemaName: 'errorResponseSchema' } } },
  { method: 'GET', path: '/entries', operationId: 'listEntries', summary: 'List recent entries', tags: ['Entries'], auth: 'session', request: { query: { schemaName: 'entryListQuerySchema' } }, responses: { '200': { description: 'List of entries', schemaName: 'entryListResponseSchema' } } },
  { method: 'GET', path: '/entries/{id}', operationId: 'getEntry', summary: 'Get an entry by ID', tags: ['Entries'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'The entry', schemaName: 'entryResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'GET', path: '/entries/{id}/fragments', operationId: 'listEntryFragments', summary: 'Get all fragments derived from an entry', tags: ['Entries'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Fragments for this entry', schemaName: 'fragmentListResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/entries/{id}/retry', operationId: 'retryEntry', summary: 'Retry a failed entry extraction', tags: ['Entries'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '202': { description: 'Entry re-queued for extraction', schemaName: 'okResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' }, '409': { description: 'Entry is not in failed state', schemaName: 'errorResponseSchema' } } },

  // ── Fragments ────────────────────────────────────────────────────────────
  { method: 'GET', path: '/fragments', operationId: 'listFragments', summary: 'List fragments', tags: ['Fragments'], auth: 'session', request: { query: { schemaName: 'fragmentListQuerySchema' } }, responses: { '200': { description: 'List of fragments', schemaName: 'fragmentListResponseSchema' } } },
  { method: 'GET', path: '/fragments/{id}', operationId: 'getFragment', summary: 'Get a fragment by ID (includes content and backlinks)', tags: ['Fragments'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Fragment with content and backlinks', schemaName: 'fragmentDetailResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/fragments', operationId: 'createFragment', summary: 'Create a new fragment', tags: ['Fragments'], auth: 'session', request: { body: { schemaName: 'createFragmentBodySchema' } }, responses: { '201': { description: 'Created fragment', schemaName: 'fragmentWithContentResponseSchema' }, '400': { description: 'Invalid input', schemaName: 'errorResponseSchema' } } },
  { method: 'PUT', path: '/fragments/{id}', operationId: 'updateFragment', summary: 'Update a fragment', tags: ['Fragments'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'updateFragmentBodySchema' } }, responses: { '200': { description: 'Updated fragment', schemaName: 'fragmentResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/fragments/{id}/accept', operationId: 'acceptFragment', summary: 'Accept fragment into a review-mode wiki', tags: ['Fragments'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'fragmentReviewBodySchema' } }, responses: { '200': { description: 'Fragment accepted', schemaName: 'okResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' }, '400': { description: 'Wiki not in review mode', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/fragments/{id}/reject', operationId: 'rejectFragment', summary: 'Reject fragment from a review-mode wiki', tags: ['Fragments'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'fragmentReviewBodySchema' } }, responses: { '200': { description: 'Fragment rejected', schemaName: 'okResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' }, '400': { description: 'Wiki not in review mode', schemaName: 'errorResponseSchema' } } },

  // ── Wikis ────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/wikis', operationId: 'listWikis', summary: 'List wikis with pagination and fragment counts', tags: ['Wikis'], auth: 'session', responses: { '200': { description: 'List of wikis', schemaName: 'wikiListResponseSchema' } } },
  { method: 'GET', path: '/wikis/{id}', operationId: 'getWiki', summary: 'Get wiki detail with fragments and people', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Wiki detail with fragments and people', schemaName: 'wikiDetailResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'PUT', path: '/wikis/{id}', operationId: 'updateWiki', summary: 'Update a wiki', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'updateWikiBodySchema' } }, responses: { '200': { description: 'Updated wiki', schemaName: 'wikiResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'GET', path: '/wikis/{id}/timeline', operationId: 'getWikiTimeline', summary: 'Audit timeline for a wiki and its fragments', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' }, query: { schemaName: 'timelineQuerySchema' } }, responses: { '200': { description: 'Timeline events', schemaName: 'auditLogResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'GET', path: '/wikis/{id}/history', operationId: 'getWikiEditHistory', summary: 'Get edit history for a wiki', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Edit history records', schemaName: 'editHistoryResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'PATCH', path: '/wikis/{id}/bouncer', operationId: 'toggleBouncerMode', summary: 'Toggle bouncer mode (auto/review)', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'bouncerModeBodySchema' } }, responses: { '200': { description: 'Updated bouncer mode', schemaName: 'bouncerModeResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'PATCH', path: '/wikis/{id}/auto-regen', operationId: 'toggleAutoRegen', summary: 'Toggle autoregen flag on a wiki', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'autoRegenBodySchema' } }, responses: { '200': { description: 'Updated autoregen flag', schemaName: 'autoRegenResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/wikis/{id}/regenerate', operationId: 'regenerateWiki', summary: 'Trigger on-demand wiki regeneration', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Regeneration result', schemaName: 'okResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/wikis/{id}/publish', operationId: 'publishWiki', summary: 'Publish a wiki with a stable nanoid slug', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Publish status', schemaName: 'publishWikiResponseSchema' }, '400': { description: 'No content to publish', schemaName: 'errorResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/wikis/{id}/unpublish', operationId: 'unpublishWiki', summary: 'Unpublish a wiki (preserves slug for re-publish)', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Unpublish status', schemaName: 'publishWikiResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/wikis/{targetId}/merge', operationId: 'mergeWikis', summary: 'Merge wikis (not implemented)', tags: ['Wikis'], auth: 'session', responses: { '501': { description: 'Not implemented', schemaName: 'errorResponseSchema' } } },
  { method: 'PUT', path: '/wikis/{id}/progress', operationId: 'updateWikiProgress', summary: 'Update wiki progress milestones', tags: ['Wikis'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'updateProgressBodySchema' } }, responses: { '200': { description: 'Updated progress', schemaName: 'updateProgressResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },

  // ── Wiki Types ───────────────────────────────────────────────────────────
  { method: 'GET', path: '/wiki-types', operationId: 'listWikiTypes', summary: 'List all wiki types', tags: ['Wiki Types'], auth: 'session', responses: { '200': { description: 'List of wiki types', schemaName: 'wikiTypeListResponseSchema' } } },
  { method: 'GET', path: '/wiki-types/{slug}', operationId: 'getWikiType', summary: 'Get a wiki type by slug', tags: ['Wiki Types'], auth: 'session', request: { params: { slug: 'string' } }, responses: { '200': { description: 'The wiki type', schemaName: 'wikiTypeResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/wiki-types', operationId: 'createWikiType', summary: 'Create a new user-defined wiki type', tags: ['Wiki Types'], auth: 'session', request: { body: { schemaName: 'createWikiTypeBodySchema' } }, responses: { '201': { description: 'Created wiki type', schemaName: 'wikiTypeResponseSchema' }, '409': { description: 'Slug conflict', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/wiki-types/setup', operationId: 'setupWikiTypes', summary: 'Seed default wiki types from YAML configs (idempotent)', tags: ['Wiki Types'], auth: 'session', responses: { '200': { description: 'Seed result' } } },
  { method: 'PUT', path: '/wiki-types/{slug}', operationId: 'updateWikiType', summary: 'Update a wiki type', tags: ['Wiki Types'], auth: 'session', request: { params: { slug: 'string' }, body: { schemaName: 'updateWikiTypeBodySchema' } }, responses: { '200': { description: 'Updated wiki type', schemaName: 'wikiTypeResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },

  // ── Published ────────────────────────────────────────────────────────────
  { method: 'GET', path: '/published/wiki/{nanoid}', operationId: 'getPublishedWiki', summary: 'Get a published wiki by nanoid slug (no auth)', tags: ['Published'], auth: 'none', request: { params: { nanoid: 'string' } }, responses: { '200': { description: 'Published wiki content', schemaName: 'publicWikiResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },

  // ── Audit Log ────────────────────────────────────────────────────────────
  { method: 'GET', path: '/audit-log', operationId: 'getAuditLog', summary: 'Query the audit log with filters', tags: ['Audit'], auth: 'session', request: { query: { schemaName: 'auditLogQuerySchema' } }, responses: { '200': { description: 'Audit events with total count', schemaName: 'auditLogResponseSchema' } } },

  // ── Threads (legacy — aliased to wikis) ──────────────────────────────────
  { method: 'GET', path: '/threads/{id}', operationId: 'getThread', summary: 'Get a thread by ID (includes wiki content)', tags: ['Threads'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Thread with wiki content', schemaName: 'wikiWithContentResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'PUT', path: '/threads/{id}', operationId: 'updateThread', summary: 'Update a thread', tags: ['Threads'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'updateWikiBodySchema' } }, responses: { '200': { description: 'Updated thread', schemaName: 'wikiResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/threads/{id}/regenerate', operationId: 'regenerateThread', summary: 'Trigger thread wiki regeneration', tags: ['Threads'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '202': { description: 'Job queued', schemaName: 'queuedResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/threads/{targetId}/merge', operationId: 'mergeThreads', summary: 'Merge threads (not implemented)', tags: ['Threads'], auth: 'session', responses: { '501': { description: 'Not implemented', schemaName: 'errorResponseSchema' } } },

  // ── People ───────────────────────────────────────────────────────────────
  { method: 'GET', path: '/people', operationId: 'listPeople', summary: 'List all people with pagination', tags: ['People'], auth: 'session', request: { query: { schemaName: 'personListQuerySchema' } }, responses: { '200': { description: 'List of people', schemaName: 'personListResponseSchema' } } },
  { method: 'GET', path: '/people/{id}', operationId: 'getPerson', summary: 'Get a person by ID (includes content and backlinks)', tags: ['People'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '200': { description: 'Person with content and backlinks', schemaName: 'personDetailResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'PUT', path: '/people/{id}', operationId: 'updatePerson', summary: 'Update a person', tags: ['People'], auth: 'session', request: { params: { id: 'lookupKey' }, body: { schemaName: 'updatePersonBodySchema' } }, responses: { '200': { description: 'Updated person', schemaName: 'personDetailResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/people/{id}/regenerate', operationId: 'regeneratePerson', summary: 'Trigger person body regeneration', tags: ['People'], auth: 'session', request: { params: { id: 'lookupKey' } }, responses: { '202': { description: 'Job queued', schemaName: 'queuedResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },

  // ── Search ───────────────────────────────────────────────────────────────
  { method: 'GET', path: '/search', operationId: 'search', summary: 'Hybrid search across fragments, wikis, and people', tags: ['Search'], auth: 'session', request: { query: { schemaName: 'searchQuerySchema' } }, responses: { '200': { description: 'Search results', schemaName: 'searchResponseSchema' }, '400': { description: 'Missing query', schemaName: 'errorResponseSchema' } } },

  // ── Graph ────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/graph', operationId: 'getGraph', summary: 'Get the knowledge graph', tags: ['Graph'], auth: 'session', responses: { '200': { description: 'Graph nodes and edges', schemaName: 'graphResponseSchema' } } },

  // ── Relationships ────────────────────────────────────────────────────────
  { method: 'GET', path: '/relationships/{type}/{id}', operationId: 'getRelationships', summary: 'Get all relationships for an object', tags: ['Relationships'], auth: 'session', request: { params: { type: 'enum: entry, fragment, thread, vault, person', id: 'lookupKey' } }, responses: { '200': { description: 'Relationships grouped by edge type', schemaName: 'relationshipsResponseSchema' }, '400': { description: 'Invalid type', schemaName: 'errorResponseSchema' } } },

  // ── Content ──────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/content/{type}/{key}', operationId: 'getContent', summary: 'Read raw or structured content', tags: ['Content'], auth: 'session', request: { params: { type: 'enum: fragment, entry, thread, person', key: 'lookupKey' } }, responses: { '200': { description: 'Content (raw or structured)', schemaName: 'contentRawResponseSchema' }, '400': { description: 'Invalid type', schemaName: 'errorResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'PUT', path: '/api/content/{type}/{key}', operationId: 'updateContent', summary: 'Write structured content', tags: ['Content'], auth: 'session', request: { params: { type: 'enum: fragment, entry, thread, person', key: 'lookupKey' } }, responses: { '200': { description: 'Content updated', schemaName: 'okResponseSchema' }, '400': { description: 'Validation failed', schemaName: 'errorResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },

  // ── Users ────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/users/profile', operationId: 'getUserProfile', summary: "Get current user's profile", tags: ['Users'], auth: 'session', responses: { '200': { description: 'User profile', schemaName: 'userProfileResponseSchema' }, '404': { description: 'Not found', schemaName: 'errorResponseSchema' } } },
  { method: 'PATCH', path: '/users/onboard', operationId: 'markOnboarded', summary: 'Mark onboarding complete', tags: ['Users'], auth: 'session', responses: { '200': { description: 'Onboarding marked', schemaName: 'okResponseSchema' } } },
  { method: 'GET', path: '/users/keypair', operationId: 'getUserKeypair', summary: "Get user's Ed25519 keypair metadata (no privateKey)", tags: ['Users'], auth: 'session', responses: { '200': { description: 'Keypair metadata (algorithm, publicKey, fingerprint)', schemaName: 'keypairResponseSchema' }, '404': { description: 'No keypair', schemaName: 'errorResponseSchema' } } },
  { method: 'POST', path: '/users/keypair/reveal', operationId: 'revealUserKeypair', summary: 'Reveal Ed25519 private key after password verify', tags: ['Users'], auth: 'session', request: { body: { schemaName: 'keypairRevealRequestSchema' } }, responses: { '200': { description: 'Keypair with decrypted privateKey', schemaName: 'keypairRevealResponseSchema' }, '401': { description: 'Invalid credentials', schemaName: 'errorResponseSchema' }, '404': { description: 'No keypair', schemaName: 'errorResponseSchema' }, '429': { description: 'Too many failed reveal attempts', schemaName: 'errorResponseSchema' } } },
  { method: 'GET', path: '/users/stats', operationId: 'getUserStats', summary: "Get user's stats", tags: ['Users'], auth: 'session', responses: { '200': { description: 'User stats', schemaName: 'userStatsResponseSchema' } } },
  { method: 'GET', path: '/users/activity', operationId: 'getUserActivity', summary: "Get user's recent activity", tags: ['Users'], auth: 'session', responses: { '200': { description: 'Recent activity', schemaName: 'userActivityResponseSchema' } } },
  { method: 'POST', path: '/users/export', operationId: 'exportUserData', summary: 'Export all user data', tags: ['Users'], auth: 'session', responses: { '200': { description: 'Full data export', schemaName: 'exportDataResponseSchema' } } },
  { method: 'POST', path: '/users/regenerate-mcp', operationId: 'regenerateMcpEndpoint', summary: 'Regenerate MCP endpoint URL', tags: ['Users'], auth: 'session', responses: { '200': { description: 'New MCP endpoint', schemaName: 'mcpEndpointResponseSchema' }, '400': { description: 'No keypair', schemaName: 'errorResponseSchema' } } },
  { method: 'DELETE', path: '/users/data', operationId: 'deleteUserData', summary: 'Delete all user data (keeps account)', tags: ['Users'], auth: 'session', responses: { '200': { description: 'Data deleted', schemaName: 'okResponseSchema' } } },
  { method: 'DELETE', path: '/users/account', operationId: 'deleteUserAccount', summary: 'Delete user account entirely', tags: ['Users'], auth: 'session', responses: { '200': { description: 'Account deleted', schemaName: 'okResponseSchema' } } },

  // ── Admin ────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/admin/retry-stuck', operationId: 'retryStuckFragments', summary: 'Re-enqueue stuck PENDING fragments', tags: ['Admin'], auth: 'none', responses: { '200': { description: 'Re-enqueue results', schemaName: 'retryStuckResponseSchema' } } },

  // ── MCP ──────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/mcp', operationId: 'mcpTransport', summary: 'MCP Streamable HTTP transport (JWT)', tags: ['MCP'], auth: 'jwt', responses: { '200': { description: 'MCP protocol response' }, '401': { description: 'Invalid token', schemaName: 'errorResponseSchema' } } },
]

// ── Generate ────────────────────────────────────────────────────────────────

const schemas: Record<string, unknown> = {}
for (const [name, schema] of Object.entries(schemaRegistry)) {
  schemas[name] = zodToJsonSchema(schema, { name, target: 'openApi3' })
}

const manifest = {
  _meta: {
    generatedAt: new Date().toISOString(),
    description: 'Route + JSON Schema manifest for OpenAPI generation. Feed to /apidoc.',
    schemaCount: Object.keys(schemas).length,
    routeCount: routes.length,
  },
  info: {
    title: 'Robin API',
    version: '0.3.0',
    description: 'REST API for Robin.OS — a personal knowledge management system.',
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  securitySchemes: {
    cookieAuth: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token', description: 'Session cookie set by better-auth after sign-in' },
    hmacAuth: { type: 'apiKey', in: 'header', name: 'X-Signature', description: 'HMAC-SHA256 signature of request body' },
    mcpToken: { type: 'apiKey', in: 'query', name: 'token', description: 'JWT token for MCP access' },
  },
  routes,
  schemas,
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(__dirname, '..', 'openapi-manifest.json')
writeFileSync(outPath, JSON.stringify(manifest, null, 2))
console.log(`Wrote ${outPath} (${routes.length} routes, ${Object.keys(schemas).length} schemas)`)

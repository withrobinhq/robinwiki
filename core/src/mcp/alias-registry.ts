/**
 * @module mcp/alias-registry
 *
 * @summary Server-side skill-pack alias registry (Stream I Phases 5+6,
 * Andrew lock 2026-05-07 -- gate #6 server-side).
 *
 * @remarks
 * Skill packs install rows in `skill_pack_aliases` mapping a friendly
 * alias name to a canonical MCP tool plus optional default args. At
 * MCP tool-list time we read those rows and register one extra virtual
 * tool per alias on the same `McpServer` instance -- the user sees
 * `/short-capture` natively in their client's tool palette and the
 * call routes to `log_entry` with the pack's args merged in.
 *
 * Canonical tool names stay registered (Andrew lock #5) so anything
 * that already learned the raw verbs keeps working.
 *
 * Loose coupling intentional: this module knows the canonical tool
 * names by string. Any new MCP tool gets aliased by inserting a row,
 * no code changes here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import type { DB } from '../db/client.js'
import { skillPackAliases } from '../db/schema.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'mcp.alias-registry' })

/**
 * Snapshot of an alias row, shaped for the resolver. Keeping this
 * separate from the drizzle row type lets tests inject fixtures
 * without touching the database.
 */
export interface AliasRow {
  pack: string
  aliasName: string
  mcpToolName: string
  argsTemplate: Record<string, unknown> | null
}

/**
 * Function signature implemented by handlers that have already been
 * registered with the canonical MCP tool. The resolver retains a
 * reference at registration time so virtual alias tools can call it
 * without re-importing.
 */
export type CanonicalToolCallback = (
  args: Record<string, unknown>,
  extra: { authInfo?: { clientId?: string } }
) => Promise<CallToolResult>

/**
 * Loads alias rows from the database. Pulled out for fakeable tests.
 */
export async function loadAliases(db: DB): Promise<AliasRow[]> {
  const rows = await db
    .select({
      pack: skillPackAliases.pack,
      aliasName: skillPackAliases.aliasName,
      mcpToolName: skillPackAliases.mcpToolName,
      argsTemplate: skillPackAliases.argsTemplate,
    })
    .from(skillPackAliases)
  return rows.map((r) => ({
    pack: r.pack,
    aliasName: r.aliasName,
    mcpToolName: r.mcpToolName,
    argsTemplate: r.argsTemplate ?? null,
  }))
}

/**
 * Register a single alias row as a virtual MCP tool. The virtual tool
 * surfaces under the alias name; calls forward to the supplied
 * canonical callback with the alias's `argsTemplate` merged in
 * (caller-supplied args win on key collision).
 *
 * Returns true if the alias was registered, false if the canonical
 * callback wasn't found (alias points at an unknown tool -- log and
 * skip rather than 500).
 */
export function registerAliasTool(
  server: McpServer,
  alias: AliasRow,
  canonicals: Map<string, CanonicalToolCallback>
): boolean {
  const canonical = canonicals.get(alias.mcpToolName)
  if (!canonical) {
    log.warn(
      { pack: alias.pack, aliasName: alias.aliasName, target: alias.mcpToolName },
      'skill-pack alias points at unknown tool — skipping'
    )
    return false
  }

  // Permissive input schema: whatever args the user passes flow
  // through, merged on top of the alias's argsTemplate. The canonical
  // tool re-validates because the MCP SDK runs the canonical's own
  // schema on the inner call.
  const inputSchema = { args: z.record(z.string(), z.unknown()).optional() }

  server.registerTool(
    alias.aliasName,
    {
      description: `[${alias.pack} pack] alias for ${alias.mcpToolName}.`,
      inputSchema,
    },
    async (rawArgs, extra) => {
      const callerArgs =
        rawArgs && typeof rawArgs === 'object' && 'args' in rawArgs
          ? ((rawArgs as { args?: Record<string, unknown> }).args ?? {})
          : (rawArgs as Record<string, unknown>) ?? {}
      const merged = { ...(alias.argsTemplate ?? {}), ...callerArgs }
      return canonical(merged, extra as { authInfo?: { clientId?: string } })
    }
  )
  return true
}

/**
 * Register every alias from `rows` against `server`. Aliases pointing
 * at unknown canonical tools are dropped (logged once). Returns the
 * count of aliases that landed.
 */
export function registerAliases(
  server: McpServer,
  rows: AliasRow[],
  canonicals: Map<string, CanonicalToolCallback>
): number {
  let count = 0
  for (const row of rows) {
    if (registerAliasTool(server, row, canonicals)) count++
  }
  return count
}

/**
 * High-level helper invoked by `createMcpServer` after the canonical
 * tools have been registered. Pulls rows from the database and binds
 * them to the live server.
 *
 * Errors are caught and logged -- a failing alias load must never
 * break the canonical tool surface.
 */
export async function attachAliasesToServer(
  server: McpServer,
  db: DB,
  canonicals: Map<string, CanonicalToolCallback>
): Promise<number> {
  try {
    const rows = await loadAliases(db)
    const landed = registerAliases(server, rows, canonicals)
    if (landed > 0) log.debug({ landed }, 'skill-pack aliases attached')
    return landed
  } catch (err) {
    log.warn({ err }, 'failed to load/register skill-pack aliases')
    return 0
  }
}

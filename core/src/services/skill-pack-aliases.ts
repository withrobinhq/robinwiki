/**
 * @module services/skill-pack-aliases
 *
 * @summary Programmatic API for skill packs (Stream C territory) to
 * install or remove alias rows in `skill_pack_aliases`. The MCP alias
 * resolver (`mcp/alias-registry.ts`) reads those rows at tool-list time
 * and surfaces them as virtual MCP tools on the live server.
 *
 * @remarks
 * - One pack -> many aliases. The unique index is on `(pack, alias_name)`,
 *   so re-installing a pack is idempotent: existing rows update in place,
 *   new rows insert.
 * - `removePack` deletes every row for a given pack. Used when a pack is
 *   uninstalled or replaced wholesale.
 * - Stream I owns this surface; Stream C wires it from the pack loader.
 */

import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { skillPackAliases } from '../db/schema.js'

export interface AliasInstallSpec {
  /** Friendly name the user types in their MCP client (e.g. `short-capture`). */
  aliasName: string
  /** Canonical MCP tool the alias forwards to (e.g. `log_entry`). */
  mcpToolName: string
  /**
   * Optional default args merged into every call. Caller-supplied args
   * win on key collision -- this is *defaults*, not *overrides*.
   */
  argsTemplate?: Record<string, unknown> | null
}

/**
 * Install (or upsert) a single alias for a pack. Returns the row id.
 */
export async function upsertAlias(
  db: DB,
  pack: string,
  spec: AliasInstallSpec
): Promise<{ id: string }> {
  const [row] = await db
    .insert(skillPackAliases)
    .values({
      pack,
      aliasName: spec.aliasName,
      mcpToolName: spec.mcpToolName,
      argsTemplate: spec.argsTemplate ?? null,
    })
    .onConflictDoUpdate({
      target: [skillPackAliases.pack, skillPackAliases.aliasName],
      set: {
        mcpToolName: spec.mcpToolName,
        argsTemplate: spec.argsTemplate ?? null,
      },
    })
    .returning({ id: skillPackAliases.id })
  return { id: row.id }
}

/**
 * Install every alias from a pack. Idempotent: each spec upserts.
 * Returns the row ids in input order.
 */
export async function installPack(
  db: DB,
  pack: string,
  specs: AliasInstallSpec[]
): Promise<{ ids: string[] }> {
  const ids: string[] = []
  for (const spec of specs) {
    const { id } = await upsertAlias(db, pack, spec)
    ids.push(id)
  }
  return { ids }
}

/**
 * Remove every alias row owned by a pack. Returns the count deleted.
 */
export async function removePack(db: DB, pack: string): Promise<number> {
  const rows = await db
    .delete(skillPackAliases)
    .where(eq(skillPackAliases.pack, pack))
    .returning({ id: skillPackAliases.id })
  return rows.length
}

/**
 * List every alias row owned by a pack. Useful for debugging and for the
 * Stream C uninstaller's "is this pack actually installed?" check.
 */
export async function listPackAliases(
  db: DB,
  pack: string
): Promise<
  Array<{
    aliasName: string
    mcpToolName: string
    argsTemplate: Record<string, unknown> | null
  }>
> {
  const rows = await db
    .select({
      aliasName: skillPackAliases.aliasName,
      mcpToolName: skillPackAliases.mcpToolName,
      argsTemplate: skillPackAliases.argsTemplate,
    })
    .from(skillPackAliases)
    .where(eq(skillPackAliases.pack, pack))
  return rows.map((r) => ({
    aliasName: r.aliasName,
    mcpToolName: r.mcpToolName,
    argsTemplate: r.argsTemplate ?? null,
  }))
}

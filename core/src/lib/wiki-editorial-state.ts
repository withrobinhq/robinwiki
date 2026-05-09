/***********************************************************************
 * @module lib/wiki-editorial-state
 *
 * @summary Derive a wiki's editorial state from its underlying signals.
 *
 * @remarks
 * Two orthogonal state machines live on the wikis table:
 *
 *   1. Queue state (`wikis.state`): PENDING, LINKING, RESOLVED, ATTACHED.
 *      Process pipeline. Owned by the regen and ingest workers.
 *   2. Editorial state (this module): empty, learning, dreaming, filed.
 *      What the user sees as the wiki's current authoring posture.
 *
 * v0.2.2 T4-bundle dropped the persisted `lifecycle_state` column. Every
 * value of editorial state is a deterministic function of
 * `{state, dirty_since, last_rebuilt_at}`, so we derive instead of
 * persisting (avoids writing the same fact twice on every transition).
 *
 * `editorialStateOf()` is the single read path for app code that needs
 * the human-facing label. `editorialStateWhere` is the Drizzle SQL
 * fragment library for queries that filter by editorial state without
 * round-tripping rows through the helper.
 ***********************************************************************/

import { z } from 'zod'
import { sql } from 'drizzle-orm'

export const EditorialState = z.enum([
  'empty',
  'learning',
  'dreaming',
  'filed',
])
export type EditorialState = z.infer<typeof EditorialState>

const WikiStateInputs = z.object({
  state: z.enum(['LINKING', 'RESOLVED', 'PENDING', 'ATTACHED']),
  dirtySince: z.date().nullable(),
  lastRebuiltAt: z.date().nullable(),
})

/**
 * Derive editorial state from underlying signals.
 *
 * Precedence (mirrors v0.2.1 lifecycle_state semantics):
 *   1. state === 'LINKING'  -> 'dreaming'  (regen in flight)
 *   2. dirty_since IS NOT NULL -> 'learning' (new content awaiting regen)
 *   3. last_rebuilt_at IS NULL -> 'empty' (never regenned)
 *   4. otherwise -> 'filed' (clean, regenned)
 */
export function editorialStateOf(
  inputs: z.infer<typeof WikiStateInputs>
): EditorialState {
  WikiStateInputs.parse(inputs)
  if (inputs.state === 'LINKING') return 'dreaming'
  if (inputs.dirtySince !== null) return 'learning'
  if (inputs.lastRebuiltAt === null) return 'empty'
  return 'filed'
}

/**
 * SQL helpers for queries that need to filter by editorial state. Use
 * these instead of inline state checks in drizzle .where() calls so the
 * derivation lives in one place.
 *
 * The fragments reference column names directly (not drizzle column
 * objects) because they're meant to be dropped into existing
 * .where(and(...)) chains alongside other column filters.
 */
export const editorialStateWhere = {
  learning: sql`dirty_since IS NOT NULL AND state != 'LINKING'`,
  dreaming: sql`state = 'LINKING'`,
  filed: sql`state = 'RESOLVED' AND dirty_since IS NULL AND last_rebuilt_at IS NOT NULL`,
  empty: sql`last_rebuilt_at IS NULL AND dirty_since IS NULL AND state != 'LINKING'`,
}

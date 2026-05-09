import type { DB } from './client.js'
import { auditLog } from './schema.js'
import { nanoid } from '../lib/id.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'audit' })

/**
 * Shape of `audit_log.detail`. Stream V (migration 0015) banned the
 * `source_client` key from this object: every entity type that used to
 * carry the value now stores it on its own `source_client` column. The
 * `source_client?: never` intersection makes a literal `source_client`
 * key a compile-time error, so re-introducing the legacy stamp gets
 * caught by tsc instead of leaking into production rows.
 *
 * Use `string` keys other than `source_client` for any new field. The
 * `unknown` value type stays intentionally wide because audit detail
 * is a junk drawer for event-specific metadata.
 */
export type AuditDetail = Record<string, unknown> & { source_client?: never }

export interface AuditEventParams {
  entityType: string
  entityId: string
  eventType: string
  source?: string
  summary: string
  detail?: AuditDetail
}

export async function emitAuditEvent(
  db: DB,
  params: AuditEventParams
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: nanoid(),
      entityType: params.entityType,
      entityId: params.entityId,
      eventType: params.eventType,
      source: params.source ?? null,
      summary: params.summary,
      detail: params.detail ?? null,
    })
  } catch (err) {
    log.warn({ err, ...params }, 'audit event emit failed')
  }
}

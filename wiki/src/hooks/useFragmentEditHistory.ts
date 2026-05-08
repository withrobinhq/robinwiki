'use client'

import { useQuery } from '@tanstack/react-query'

/**
 * Per-edit shape returned by `GET /fragments/:id/history`. Mirrors the
 * `EditRecordSchema` that wikis already expose; Stream A5 owns the
 * server side. We define the type locally so this client compiles
 * before the SDK regenerates against A5's OpenAPI spec.
 */
export type FragmentEditRecord = {
  id: string
  timestamp: string
  type: string
  source: string
  contentSnippet: string
}

/**
 * Optional audit-log envelope. Stream A5 may surface an `auditEvents`
 * array alongside `edits` so the timeline can fold in non-edit events
 * (regen, accept, reject) once the contract settles. Treated as
 * optional today — absence is a no-op for the renderer.
 */
export type FragmentAuditEvent = {
  id: string
  timestamp: string
  type: string
  source?: string
  detail?: string
}

export type FragmentHistoryResponse = {
  edits: FragmentEditRecord[]
  total?: number
  auditEvents?: FragmentAuditEvent[]
}

/**
 * Fetch the per-fragment edit history. Uses raw `fetch` rather than the
 * generated SDK because A5 is shipping in parallel with this client and
 * the codegen hasn't run yet against A5's OpenAPI block. Once the SDK
 * regenerates, swap in `getFragmentEditHistory({ path: { id } })`.
 *
 * Treats 404 as "no history captured yet" so the component renders an
 * empty state instead of an error banner. Other non-OK statuses bubble
 * to React Query as errors.
 */
export function useFragmentEditHistory(id: string | undefined) {
  return useQuery<FragmentHistoryResponse>({
    queryKey: ['fragment-edit-history', id],
    queryFn: async () => {
      const response = await fetch(`/api/api/fragments/${id}/history`, {
        credentials: 'include',
      })
      if (response.status === 404) {
        return { edits: [], total: 0 }
      }
      if (!response.ok) {
        throw new Error(`Fragment history fetch failed (${response.status})`)
      }
      const json = (await response.json()) as Partial<FragmentHistoryResponse>
      return {
        edits: Array.isArray(json.edits) ? json.edits : [],
        total: typeof json.total === 'number' ? json.total : undefined,
        auditEvents: Array.isArray(json.auditEvents)
          ? json.auditEvents
          : undefined,
      }
    },
    enabled: !!id,
    // Edit history is append-only; a stale cache is fine for a few seconds.
    staleTime: 30_000,
    retry: false,
  })
}

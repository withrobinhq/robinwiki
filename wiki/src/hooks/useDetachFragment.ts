'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'

/**
 * Un-attach a fragment from a wiki by soft-deleting the FRAGMENT_IN_WIKI edge.
 * Calls DELETE /wikis/:id/fragments/:fragmentId (Stream E2).
 *
 * The endpoint is not yet in the OpenAPI spec / codegen, so we use fetch
 * directly. The /api prefix is rewritten by the Next.js proxy to the core
 * server, matching the pattern used by the generated SDK client (baseUrl: '/api').
 */
export function useDetachFragment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ wikiId, fragmentId }: { wikiId: string; fragmentId: string }) => {
      const res = await fetch(`/api/wikis/${wikiId}/fragments/${fragmentId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(body || `Failed to un-attach fragment (${res.status})`)
      }
      return res.json()
    },
    onSuccess: (_data, { wikiId }) => {
      queryClient.invalidateQueries({ queryKey: ['wiki', wikiId] })
      queryClient.invalidateQueries({ queryKey: ['wikis'] })
    },
  })
}

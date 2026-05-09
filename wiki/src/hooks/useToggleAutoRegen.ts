'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toggleAutoRegen } from '@/lib/api'

// Stream U: optimistic toggle for the per-wiki autoregen flag. Used by
// the settings Wikis panel. Failures revert and surface via the mutation
// error state so the caller can re-render the previous value.

export function useToggleAutoRegen() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, autoregen }: { id: string; autoregen: boolean }) => {
      const { data } = await toggleAutoRegen({ path: { id }, body: { autoregen } })
      return data
    },
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['wiki', id] })
      queryClient.invalidateQueries({ queryKey: ['wikis'] })
    },
  })
}

'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/generated/client.gen'

export function useRetryEntry() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await client.post({
        url: '/entries/{id}/retry',
        path: { id },
      })
      return data
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['entry', id] })
      queryClient.invalidateQueries({ queryKey: ['entries'] })
    },
  })
}

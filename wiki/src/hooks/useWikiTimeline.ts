'use client'

import { useQuery } from '@tanstack/react-query'
import { getWikiTimeline } from '@/lib/api'

export function useWikiTimeline(id: string | undefined) {
  return useQuery({
    queryKey: ['wiki-timeline', id],
    queryFn: async () => {
      const { data } = await getWikiTimeline({ path: { id: id! } })
      return data
    },
    enabled: !!id,
  })
}

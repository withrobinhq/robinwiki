'use client'

import { useQuery } from '@tanstack/react-query'
import { listWikis } from '@/lib/api'

export function useWikis() {
  return useQuery({
    queryKey: ['wikis'],
    queryFn: async () => {
      // Backend default is 50; bump to the schema's effective ceiling so the
      // sidebar + Browse views surface every wiki in the deployment. The
      // generated SDK marks `query: never` because the OpenAPI spec omits
      // the documented `limit/offset/type` params, so the cast is the
      // minimum-friction workaround until the spec is regenerated.
      const { data } = await listWikis({ query: { limit: 200 } } as unknown as Parameters<typeof listWikis>[0])
      return data
    },
  })
}

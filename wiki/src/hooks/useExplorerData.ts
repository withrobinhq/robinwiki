'use client'

import { useMemo } from 'react'
import { useWikis } from '@/hooks/useWikis'
import { useFragments } from '@/hooks/useFragments'
import { usePeople } from '@/hooks/usePeople'
import { useEntries } from '@/hooks/useEntries'
import { useCollections, type Collection } from '@/hooks/useCollections'
import type { ExplorerFilters } from '@/hooks/useExplorerFilters'
import { ROUTES } from '@/lib/routes'

export interface ExplorerItemCollection {
  id: string
  name: string
  color: string
}

export interface ExplorerItem {
  id: string
  lookupKey: string
  type: 'fragment' | 'wiki' | 'person' | 'entry'
  subtype: string | null
  title: string
  collections: ExplorerItemCollection[]
  date: string
  href: string
}

function capitalize(s: string | null | undefined): string {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export function useExplorerData(filters: ExplorerFilters) {
  const wikisQuery = useWikis()
  const fragmentsQuery = useFragments({ limit: 500 })
  const peopleQuery = usePeople({ limit: 500 })
  const entriesQuery = useEntries({ limit: 500 })
  const collectionsQuery = useCollections()

  const isLoading =
    wikisQuery.isLoading || fragmentsQuery.isLoading || peopleQuery.isLoading || entriesQuery.isLoading || collectionsQuery.isLoading
  const isError =
    wikisQuery.isError || fragmentsQuery.isError || peopleQuery.isError || entriesQuery.isError || collectionsQuery.isError

  const items = useMemo(() => {
    const result: ExplorerItem[] = []

    // Wikis (threads). The list endpoint returns wiki.collections; previously
    // dropped here, which caused the collection filter to match nothing.
    for (const wiki of wikisQuery.data?.wikis ?? []) {
      result.push({
        id: wiki.id,
        lookupKey: wiki.lookupKey,
        type: 'wiki',
        subtype: capitalize(wiki.type),
        title: wiki.name,
        collections: (wiki.collections ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
        })),
        date: wiki.updatedAt,
        href: `/wiki/${wiki.lookupKey}`,
      })
    }

    // Fragments, people, entries do not carry collection memberships in the
    // data model (collections attach to wikis only via group_wikis), so an
    // empty list correctly excludes them under a collection filter.
    for (const frag of fragmentsQuery.data?.fragments ?? []) {
      result.push({
        id: frag.id,
        lookupKey: frag.lookupKey,
        type: 'fragment',
        subtype: capitalize(frag.type),
        title: frag.title,
        collections: [],
        date: frag.updatedAt,
        href: ROUTES.fragment(frag.lookupKey),
      })
    }

    for (const person of peopleQuery.data?.people ?? []) {
      result.push({
        id: person.id,
        lookupKey: person.lookupKey,
        type: 'person',
        subtype: null,
        title: person.name,
        collections: [],
        date: person.updatedAt,
        href: ROUTES.person(person.lookupKey),
      })
    }

    for (const entry of entriesQuery.data?.entries ?? []) {
      result.push({
        id: entry.id,
        lookupKey: entry.lookupKey,
        type: 'entry',
        subtype: null,
        title: entry.title,
        collections: [],
        date: entry.createdAt,
        href: ROUTES.entry(entry.lookupKey),
      })
    }

    // Apply type filter
    let filtered = result
    if (filters.types.length > 0) {
      filtered = filtered.filter((item) => filters.types.includes(item.type))
    }

    // Apply collection filter
    if (filters.collection) {
      const collectionId = filters.collection
      filtered = filtered.filter((item) =>
        item.collections.some((c) => c.id === collectionId),
      )
    }

    // Apply sort
    if (filters.sort === 'recent') {
      filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    } else if (filters.sort === 'oldest') {
      filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    } else {
      filtered.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
    }

    return filtered
  }, [
    wikisQuery.data,
    fragmentsQuery.data,
    peopleQuery.data,
    entriesQuery.data,
    filters.types,
    filters.collection,
    filters.sort,
  ])

  const collections: Collection[] = collectionsQuery.data ?? []

  return { items, isLoading, isError, collections }
}

'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

// Stream U: hooks for the People panel.
//
// These call /admin/people endpoints owned by Stream P
// (feat/people-extractor-and-quarantine). Stream P has not merged yet;
// the panel is built against the documented spec so the moment Stream P
// lands, the endpoints flip on without UI changes. While Stream P is
// out of tree, GET /admin/people?status=pending returns 404 and the
// panel renders the "no pending people" empty state.
//
// We deliberately do NOT consume the typed SDK here because the
// /admin/people surface is part of Stream P, not Stream U, so we
// hand-roll the fetch shape rather than commit a stub schema that
// drifts when P regenerates the SDK.

export interface PendingPerson {
  id: string
  lookupKey: string
  slug: string
  name: string
  aliases?: string[]
  mentionCount?: number
  createdAt: string
  status: 'pending' | 'verified' | 'rejected'
  extractedFromFragmentId?: string | null
  extractedFromFragmentSnippet?: string | null
}

interface PendingPersonsResponse {
  people: PendingPerson[]
}

export function usePendingPersons() {
  return useQuery<PendingPersonsResponse>({
    queryKey: ['admin-people', 'pending'],
    queryFn: async () => {
      const res = await fetch('/api/admin/people?status=pending', {
        credentials: 'include',
      })
      if (res.status === 404) {
        // Stream P not yet merged — surface as empty rather than error.
        return { people: [] }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `Failed: ${res.status}`)
      }
      return (await res.json()) as PendingPersonsResponse
    },
  })
}

export function useApprovePerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (personKey: string) => {
      const res = await fetch(
        `/api/admin/people/${encodeURIComponent(personKey)}/approve`,
        { method: 'POST', credentials: 'include' },
      )
      if (!res.ok) throw new Error(`Approve failed: ${res.status}`)
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-people'] })
      qc.invalidateQueries({ queryKey: ['people'] })
    },
  })
}

export function useRejectPerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { personKey: string; hardDelete?: boolean }) => {
      const url = `/api/admin/people/${encodeURIComponent(args.personKey)}/reject`
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hardDelete: Boolean(args.hardDelete) }),
      })
      if (!res.ok) throw new Error(`Reject failed: ${res.status}`)
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-people'] })
      qc.invalidateQueries({ queryKey: ['people'] })
    },
  })
}

export function useAutoAcceptPersons() {
  const qc = useQueryClient()

  const get = useQuery<{ autoAcceptPersons: boolean }>({
    queryKey: ['admin-settings', 'auto-accept-persons'],
    queryFn: async () => {
      const res = await fetch('/api/admin/settings/auto-accept-persons', {
        credentials: 'include',
      })
      if (res.status === 404) {
        // Stream P not yet merged.
        return { autoAcceptPersons: false }
      }
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      return res.json()
    },
  })

  const set = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch('/api/admin/settings/auto-accept-persons', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoAcceptPersons: next }),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings', 'auto-accept-persons'] })
    },
  })

  return { get, set }
}

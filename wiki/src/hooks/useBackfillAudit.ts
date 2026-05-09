'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getBackfillAudit,
  getBackfillRuns,
  triggerWikiAgentSchemaBackfill,
} from '@/lib/api'

// Stream U: hooks for the Backfill panel.
//
// The audit endpoint is read-only and lists wikis missing description /
// hyde rows in wiki_agent_schema. The trigger endpoint runs the same
// loop as the CLI script, returns counts, and records a row to
// scheduled_jobs that the runs endpoint surfaces. The panel renders the
// audit, and clicking "run backfill" enqueues the trigger and refreshes
// both queries.

export function useBackfillAudit() {
  return useQuery({
    queryKey: ['backfill', 'audit'],
    queryFn: async () => {
      const { data } = await getBackfillAudit()
      return data
    },
  })
}

export function useBackfillRuns() {
  return useQuery({
    queryKey: ['backfill', 'runs'],
    queryFn: async () => {
      const { data } = await getBackfillRuns()
      return data
    },
  })
}

export function useTriggerWikiAgentSchemaBackfill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: { wikiKey?: string }) => {
      const { data } = await triggerWikiAgentSchemaBackfill({
        body: args.wikiKey ? { wikiKey: args.wikiKey } : {},
      })
      return data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backfill'] })
      qc.invalidateQueries({ queryKey: ['wikis'] })
    },
  })
}

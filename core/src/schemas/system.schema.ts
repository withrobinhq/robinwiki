import { z } from 'zod'

export const systemStatusResponseSchema = z.object({
  status: z.string(),
  initialized: z.boolean(),
  version: z.string(),
  instanceId: z.string(),
  onboarded: z.boolean(),
  createdAt: z.string().nullable(),
})

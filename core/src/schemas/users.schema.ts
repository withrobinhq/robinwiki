import { z } from 'zod'
import { okResponseSchema } from './base.schema.js'

// ── Response schemas ────────────────────────────────────────────────────────

export const userProfileResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  mcpEndpointUrl: z.string(),
  apiKeyHint: z.string(),
  onboardedAt: z.string().nullable(),
})

export const userStatsResponseSchema = z.object({
  totalNotes: z.number(),
  totalThreads: z.number(),
  peopleCount: z.number(),
  unthreadedCount: z.number(),
  lastSync: z.string(),
})

export const activityItemSchema = z.object({
  action: z.string(),
  time: z.string(),
})

export const userActivityResponseSchema = z.object({
  activity: z.array(activityItemSchema),
})

export const keypairResponseSchema = z.object({
  algorithm: z.string(),
  publicKey: z.string(),
  // sha256 of the SPKI-DER public key bytes, hex, lowercase. Lets the UI
  // display a stable identifier without ever surfacing the private key.
  fingerprint: z.string(),
})

export const keypairRevealRequestSchema = z.object({
  password: z.string().min(1),
})

export const keypairRevealResponseSchema = z.object({
  algorithm: z.string(),
  publicKey: z.string(),
  privateKey: z.string(),
  fingerprint: z.string(),
})

export const mcpEndpointResponseSchema = z.object({
  mcpEndpointUrl: z.string(),
})

export const exportDataResponseSchema = z.object({
  exportedAt: z.string(),
  wikis: z.array(z.any()),
  fragments: z.array(z.any()),
  people: z.array(z.any()),
})


// ── User settings ──────────────────────────────────────────────────────────

/** Full settings shape — used for GET responses and as the defaults type. */
export const fullUserSettingsSchema = z.object({
  notifications: z.object({
    email: z.boolean(),
    push: z.boolean(),
  }),
  privacy: z.object({
    publicProfile: z.boolean(),
  }),
  theme: z.enum(['light', 'dark', 'system']),
})

/** Partial input schema — every top-level key is optional for PATCH-style PUT. */
export const userSettingsSchema = fullUserSettingsSchema.partial()

export type UserSettings = z.infer<typeof fullUserSettingsSchema>

export const USER_SETTINGS_DEFAULTS: UserSettings = {
  notifications: { email: true, push: true },
  privacy: { publicProfile: false },
  theme: 'system',
}

export const userSettingsResponseSchema = fullUserSettingsSchema

export { okResponseSchema }

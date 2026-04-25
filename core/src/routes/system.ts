import { Hono } from 'hono'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { getConfig, setConfig } from '../lib/config.js'
import { nanoid } from '../lib/id.js'
import { isNotNull } from 'drizzle-orm'

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

export const systemRoutes = new Hono()

async function getOrCreateInstanceId(): Promise<string> {
  const existing = await getConfig({
    scope: 'system',
    kind: 'instance',
    key: 'id',
  })

  if (typeof existing === 'string') return existing

  const instanceId = `robin-${nanoid()}`
  await setConfig({
    scope: 'system',
    kind: 'instance',
    key: 'id',
    value: instanceId,
  })
  return instanceId
}

systemRoutes.get('/status', async (c) => {
  const [user] = await db
    .select({
      onboardedAt: users.onboardedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isNotNull(users.onboardedAt))
    .limit(1)

  const onboarded = !!user?.onboardedAt

  // If no onboarded user, check if any user exists at all
  let createdAt: string | null = null
  if (user) {
    createdAt = user.createdAt.toISOString()
  } else {
    const [anyUser] = await db
      .select({ createdAt: users.createdAt })
      .from(users)
      .limit(1)
    if (anyUser) {
      createdAt = anyUser.createdAt.toISOString()
    }
  }

  const instanceId = await getOrCreateInstanceId()

  return c.json({
    status: 'ok',
    initialized: onboarded,
    version: pkg.version,
    instanceId,
    onboarded,
    createdAt,
  })
})

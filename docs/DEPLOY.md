# Deploying Robin on Railway

Robin ships as two services (core API, wiki frontend) backed by Postgres + Redis. This guide covers two paths: one-click template deploy, and per-service manual setup.

## Topology

```
                      +------------------------+
                      |   Public (browsers)    |
                      +-----------+------------+
                                  |
                                  | HTTPS
                                  v
                          +---------------+
                          |     wiki      |   Next.js (port 8080)
                          |  (public URL) |   next.config.ts rewrites /api/* -> core
                          +-------+-------+
                                  |
                                  | Railway private network
                                  | http://core.railway.internal:3000
                                  v
                          +---------------+
                          |     core      |   Hono + workers (port 3000)
                          |  (public URL) |   /health, /api/*, /admin/queues
                          +---+-------+---+
                              |       |
                private TCP   |       |   private TCP
              +---------------+       +-----------------+
              v                                         v
      +----------------+                       +----------------+
      |   postgres     |                       |     redis      |
      |  (pgvector)    |                       |   (BullMQ)     |
      +----------------+                       +----------------+
```

Core hosts the HTTP API, MCP server, and BullMQ workers inline. Wiki is a Next.js app whose server-side rewrites proxy every `/api/*` request to core — browsers never hit core directly.

## Quick deploy (template path)

1. Click the Railway template link for this repo. Railway reads `railway.template.json` and scaffolds four services: `postgres`, `redis`, `core`, `wiki`.
2. Fill in the prompted env vars (see reference table below). The required ones with no default are: `BETTER_AUTH_SECRET`, `MASTER_KEY`, `KEY_ENCRYPTION_SECRET`, `JOB_SIGNING_SECRET`, `OPENROUTER_API_KEY`, `INITIAL_USERNAME`, `INITIAL_PASSWORD`. Leave `SERVER_PUBLIC_URL` and `WIKI_ORIGIN` blank for now — you will fill them after first deploy.
3. Click Deploy. Wait for all four services to go green.
4. Run the pre-deploy SQL (see below) against Postgres — this is a one-shot manual step until Phase D2 automates it.
5. Copy the generated public URLs for `core` and `wiki` back into `SERVER_PUBLIC_URL` and `WIKI_ORIGIN` respectively. Redeploy both services.
6. Visit the wiki URL and sign in with `INITIAL_USERNAME` / `INITIAL_PASSWORD`.

## Manual deploy (per-service path)

Use this if you prefer to wire services by hand, or Railway's template flow does not support something you need.

1. **Create a Railway project.**
2. **Add Postgres.** Use Railway's Postgres plugin (or the `postgres-ssl` image for pgvector-ready setups). Note the generated `DATABASE_URL`.
3. **Add Redis.** Use Railway's Redis plugin. Note the generated `REDIS_URL`.
4. **Add the `core` service.** Deploy from this GitHub repo. In the service settings under Build, set **Railpack Config File** to `railpack.core.json`. Under Variables, set:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - Everything from the reference table marked "manual"
5. **Add the `wiki` service.** Deploy from the same repo. Set **Railpack Config File** to `railpack.wiki.json`. Under Variables, set:
   - `NEXT_PUBLIC_ROBIN_API` = `http://${{core.RAILWAY_PRIVATE_DOMAIN}}:${{core.PORT}}`
6. Generate public domains for `core` and `wiki`. Copy them back into `core.SERVER_PUBLIC_URL` and `core.WIKI_ORIGIN`. Redeploy core.
7. Run the pre-deploy SQL on Postgres.

## Env var reference

| Var | Service | Required | Source | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | core | yes | plugin ref | Postgres connection string. |
| `REDIS_URL` | core | yes | plugin ref | Redis connection string for BullMQ. |
| `BETTER_AUTH_SECRET` | core | yes | manual | Session cookie signing secret. 32+ chars. `openssl rand -base64 48`. |
| `MASTER_KEY` | core | yes | manual | Root key that wraps per-user KEKs. 64 hex chars. `openssl rand -hex 32`. **Losing this destroys all user data.** |
| `KEY_ENCRYPTION_SECRET` | core | yes | manual | HMAC secret for MCP JWTs and worker tokens. 32+ chars. `openssl rand -base64 48`. |
| `JOB_SIGNING_SECRET` | core | yes | manual | HMAC secret for BullMQ job payload signing. 32+ chars. `openssl rand -hex 32`. Producer signs every job; worker verifies on dequeue. |
| `OPENROUTER_API_KEY` | core | yes | manual | Default OpenRouter key used for LLM calls. |
| `INITIAL_USERNAME` | core | yes | manual | Bootstrap admin email. Created on first boot if no users exist. |
| `INITIAL_PASSWORD` | core | yes | manual | Bootstrap admin password. Rotate after first login (force-reset tracked in #71). |
| `SERVER_PUBLIC_URL` | core | yes | manual | Core's public Railway URL. Drives BetterAuth `baseURL`, cookie flags, and email links. Fill after first deploy. |
| `WIKI_ORIGIN` | core | yes | manual | Wiki's public Railway URL(s). Comma-separated for multiple. Drives BetterAuth `trustedOrigins`. Fill after first deploy. |
| `PORT` | core | no | default `3000` | HTTP listen port. Railway sets this automatically when it generates a domain. |
| `NODE_ENV` | core | no | default `production` | Standard Node flag. |
| `LOG_LEVEL` | core | no | default `info` | Pino log level. |
| `DEFAULT_MODEL` | core | no | manual | Override default LLM model. |
| `EXTRACTION_MODEL` | core | no | manual | Override fragment-extraction model. |
| `WIKI_CLASSIFY_MODEL` | core | no | manual | Override classify model. |
| `WIKI_GENERATION_MODEL` | core | no | manual | Override wiki-generation model. |
| `EMBEDDING_MODEL` | core | no | manual | Override embedding model. |
| `NEXT_PUBLIC_ROBIN_API` | wiki | yes | service ref | Points wiki's server-side rewrites at core. Use core's private domain. |
| `PORT` | wiki | no | default `8080` | HTTP listen port. Railway sets this automatically when it generates a domain. |
| `NODE_ENV` | wiki | no | default `production` | Standard Node flag. |

## Pre-deploy SQL

Robin's vector search requires the pgvector extension. Run this once against Postgres after provisioning:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Railway's Postgres plugin ships pgvector in the `postgres-ssl` image family; the `CREATE EXTENSION` call above enables it for the database. A follow-up phase (D2, separate PR) will automate this as part of core's boot sequence.

## Networking note: private domain for wiki -> core

`NEXT_PUBLIC_ROBIN_API` points at core's **private** Railway domain (`http://${{core.RAILWAY_PRIVATE_DOMAIN}}:${{core.PORT}}`), not its public URL. This is intentional:

- Wiki's `next.config.ts` rewrites run on the server, not in the browser. Clients never read `NEXT_PUBLIC_ROBIN_API` — they only ever hit `wiki.up.railway.app/api/*`.
- Private-network traffic on Railway is free, stays inside the platform, and is faster than egressing through the public HTTPS terminator.
- If core ever needs to be publicly reachable (for MCP, webhooks, etc.), that is controlled separately via `SERVER_PUBLIC_URL`.

Despite the `NEXT_PUBLIC_` prefix (a Next.js convention), this value is only consumed at build time for `next.config.ts` and at runtime by server code.

## Post-deploy checks

1. `curl https://<core-url>/health` → `{"status":"ok",...}`.
2. Open `https://<wiki-url>/` in a browser → wiki home renders.
3. Sign in with `INITIAL_USERNAME` / `INITIAL_PASSWORD`.
4. Open `https://<core-url>/admin/queues` → confirm 4 workers listed and running. **Note:** this route is currently unauthenticated — auth gating is tracked in issue #73. Do not publicly expose this path until that lands.

## Troubleshooting

**Core crash-loops on boot with `DATABASE_URL env var is required`.**
The core service is missing `DATABASE_URL`. Confirm the variable is set to `${{Postgres.DATABASE_URL}}` (or the raw connection string) and redeploy.

**Core boots but all crypto operations fail with `MASTER_KEY is required` or similar.**
`MASTER_KEY` is missing or not 64 hex chars. Regenerate with `openssl rand -hex 32` and redeploy. Note: rotating `MASTER_KEY` on an existing database invalidates every user's encrypted KEK — only change it before any user signs up.

**Core logs `relation "fragments" does not exist` or similar during worker boot.**
Migrations have not run. Shell into core (or run locally against the prod DB): `pnpm --filter @robin/core db:push`.

**Core logs `type "vector" does not exist`.**
pgvector is not enabled on the database. Run `CREATE EXTENSION IF NOT EXISTS vector;` against Postgres (see Pre-deploy SQL).

**Wiki boots but `/api/*` calls 502 or time out.**
`NEXT_PUBLIC_ROBIN_API` is pointing at the wrong host. Verify it resolves to core on the private network: `http://${{core.RAILWAY_PRIVATE_DOMAIN}}:${{core.PORT}}`. Remember wiki must be rebuilt (not just restarted) after changing this value — it is baked into the Next.js build.

**Sign-in succeeds on core but the wiki redirects back to the login page.**
`WIKI_ORIGIN` on core does not include the wiki's public URL, so BetterAuth rejects the cross-origin cookie. Set `WIKI_ORIGIN=https://<wiki-public-url>` on core and redeploy.

**`/admin/queues` shows 0 workers.**
Core's worker bootstrap failed silently. Check core logs for `KEY_ENCRYPTION_SECRET` or Redis connection errors. Workers run inline with the HTTP server (separate worker service is tracked in #72).

## Migration squash (single-bootstrap schema)

The 14-migration chain (`0000_init` … `0013_people_is_owner`) has been collapsed into a single `0000_bootstrap.sql`. Fresh installs are unaffected — drizzle's migrator applies the bootstrap once and produces the same schema the chain did.

**Existing deployments must wipe their database before pulling this version.** Drizzle's `__drizzle_migrations` tracking table records each applied migration by name + hash; with the chain replaced, the tracker sees `0000_bootstrap` as un-applied and tries to re-run it, which fails on already-existing tables. There is no in-place upgrade path because the new bootstrap is not a no-op against a populated DB.

Robin is not yet GA, so no production data is affected. If a prior deploy needs to be carried forward, dump the data, drop the schema, redeploy with the squashed migrations, and reload the dump.

## Known gaps in the Railway template

- `railway.template.json` follows Railway's current config-as-code shape, but Railway's template spec is evolving and some fields (e.g. per-variable `required` enforcement, post-deploy SQL hooks) are not yet first-class. Variables without a `default` are documented via `description` so Railway's UI prompts the operator; if any are skipped, deploys will fail loudly on boot.
- Pre-deploy SQL (`CREATE EXTENSION vector`) is not automated in the template. Phase D2 will move this into core's boot sequence. Until then, it is manual.
- `SERVER_PUBLIC_URL` / `WIKI_ORIGIN` cannot be auto-populated at template-deploy time because Railway generates public domains after the service exists. These are a two-pass setup: deploy, copy the generated URLs, redeploy.

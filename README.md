# Robin

*A second brain that organizes itself.*

Talk to Robin through Claude Desktop, the web, or any MCP client. It listens, breaks what you say into atomic ideas, and files them into topic-clustered wikis you can search and edit. The point: capture without the friction of categorizing, then trust that whatever you said in March is one search away in November.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/robinwiki?referralCode=55-uGO&utm_medium=readme&utm_source=github&utm_campaign=deploy-button)

## Table of Contents

- [What Robin does](#what-robin-does)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Deploy](#deploy)
  - [Strategy 1 — Template](#strategy-1--template)
  - [Strategy 2 — Fork + Re-point](#strategy-2--fork--re-point)
  - [Strategy 3 — Standalone (Eject)](#strategy-3--standalone-eject)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Account password](#account-password)
- [MCP Tools](#mcp-tools)
- [API](#api)
- [Scripts](#scripts)
- [Contributing](#contributing)
- [License](#license)

## What Robin does

You think out loud. Robin keeps the thread.

A typical capture looks like this:

> *You, in Claude Desktop:* "I just realized the bouncer-mode flag should be per-wiki, not global. The whole point of strict review on the Decisions wiki is that it's high-stakes. Letting that bleed onto the Drafts wiki where I'm just thinking out loud would kill the value."

Behind the scenes, Robin:

1. **Captures the raw text** as an entry in the audit log
2. **Splits it into fragments** — atomic ideas, one thought each, fluff stripped
3. **Classifies each fragment** into a wiki by topic — "bouncer-mode design" goes to your *Decisions* wiki; the *Drafts* mention links a sibling fragment in *Drafts*
4. **Regenerates the wiki bodies** so the new fragments show up in prose, with citations linking back to the original
5. **Indexes everything** for search — both keyword (BM25) and semantic (vector cosine), fused with reciprocal rank fusion

A week later, "what was my position on bouncer mode?" surfaces both fragments, the wiki body that synthesizes them, and the timeline of how the thought evolved.

## Architecture

Single-tenant, single-user, Postgres-backed. Everything you write lives as text rows in Postgres — no git-backed markdown store, no filesystem repo. The server owns auth, the API, the MCP endpoint, and the AI pipeline.

Monorepo managed by pnpm workspaces + Turborepo:

```
core/             @robin/core    — Hono API server, MCP server, AI pipeline, workers
wiki/             @robin/wiki    — Next.js 16 web frontend (shadcn/ui)
packages/agent    @robin/agent   — LLM agent utilities, person resolution
packages/queue    @robin/queue   — BullMQ producer/consumer abstractions
packages/shared   @robin/shared  — Shared types, lookup keys, slug helpers
packages/caslock  @robin/caslock — CAS-based distributed locking
```

## Tech Stack

| Layer | Stack |
|-------|-------|
| API | Hono, Zod, better-auth |
| Database | PostgreSQL + pgvector, Drizzle ORM |
| Queue | Redis + BullMQ |
| AI | OpenRouter (Claude, embeddings), Mastra |
| Frontend | Next.js 16, React 19, Tailwind CSS, shadcn/ui |
| Tooling | TypeScript, Biome, Vitest, Turborepo, pnpm |

## Deploy

We've optimized deployments for Railway. Three strategies, in increasing order of independence:

| Strategy | Setup | Auto-updates | Customizable | Best for |
|---|---|---|---|---|
| **1. Template** (easy) | ~2 min | Yes — from upstream | No | Trying it out, hosted demos |
| **2. Fork + Re-point** | ~5 min | Via Railway's `Check for updates` | Yes | Personal use with optional upstream tracking |
| **3. Standalone (Eject)** | ~15 min | Manual `git pull` | Yes | Private instance, derivative product |

### Strategy 1 — Template

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/robinwiki?referralCode=55-uGO&utm_medium=readme&utm_source=github&utm_campaign=deploy-button)

Connects directly to upstream. Auto-updates whenever we push to `main`.
**You can't customize the code, and your instance redeploys when we update upstream — including breaking changes.**
Best for trying Robin out or running a hosted demo.

### Strategy 2 — Fork + Re-point

1. [Fork this repo →](https://github.com/withrobinhq/robinwiki/fork)
2. Click the `Deploy on Railway` button above. This uses the published template to provision postgres + redis + `@robin/core` + `@robin/wiki` with all env vars pre-populated.
3. After the initial deploy completes, open each of `@robin/core` and `@robin/wiki` in turn. In **Settings → Source**, change the connected `Source Repo` from `withrobinhq/robinwiki` to your fork (`<your-username>/robinwiki`). Leave `Upstream Repo` alone — that's what powers Railway's `Check for updates` flow, which surfaces upstream changes as PRs against your fork.
4. Trigger a redeploy on each service. Railway now pulls from your fork; future pushes to your fork auto-deploy.

<!-- TODO: screenshot of Settings → Source panel with Source Repo field annotated -->

**You decide when to pull upstream updates, and you can edit the code.**
Best if you want stability with optional upstream tracking, or want to customize prompts, models, UI, etc.

> Why this works: the Railway template URL is hardcoded to deploy from upstream. Clicking the button alone — even from your fork's README — provisions services that pull from `withrobinhq/robinwiki`. Re-pointing the source after the initial deploy is the cleanest way to keep the template's env-var pre-population while running off your fork.

### Strategy 3 — Standalone (Eject)

Most independence, most setup. You own everything end-to-end — no upstream tracking, no `Check for updates` flow.

1. Fork or clone the repo.
2. Create a new Railway project (don't use the template).
3. Add a Postgres service — set the source image to `pgvector/pgvector:pg17`.
4. Add a Redis service — Railway's default Redis works.
5. Add a service for `@robin/core`: **Deploy from GitHub repo** → select your fork. Then in **Settings → Build → Railway Config File**, set the path to `railpack.core.json`.
6. Add a service for `@robin/wiki`: same flow, with `railpack.wiki.json`.
7. Set env vars manually for all four services — see `core/.env.example` or copy from a working template-based deploy.
8. Trigger initial deploy.

<!-- TODO: screenshot of Settings → Build → Railway Config File field -->

Trade-off: ~10 extra minutes of env-var setup that strategies 1 + 2 skip. No `Check for updates` — pull upstream changes by hand via `git pull`.

#### Keeping your fork in sync (Strategies 2 + 3)

```bash
git remote add upstream https://github.com/withrobinhq/robinwiki.git
git fetch upstream
git merge upstream/main
git push
```

## Local Setup

If you want to run Robin on your own machine — for hacking on the code, or because you'd rather host on something other than Railway.

Two paths: **Nix** (recommended, one command provisions Postgres+pgvector, Redis, Node, pnpm) or **manual** (bring your own services).

### Env file setup (both paths)

```bash
cp core/.env.example core/.env
cp wiki/.env.example wiki/.env
```

Generate each of the five required secrets and paste it into the matching variable in `core/.env`:

```bash
openssl rand -hex 32   # paste into BETTER_AUTH_SECRET
openssl rand -hex 32   # paste into MASTER_KEY (must be 64 hex chars)
openssl rand -hex 32   # paste into KEY_ENCRYPTION_SECRET
openssl rand -hex 32   # paste into RECOVERY_SECRET
openssl rand -hex 32   # paste into JOB_SIGNING_SECRET
```

Then fill in the user-supplied values in `core/.env`:

```env
OPENROUTER_API_KEY=sk-or-v1-...
INITIAL_USERNAME=you@example.com
INITIAL_PASSWORD=something-you-can-remember
```

`DATABASE_URL`, `REDIS_URL`, `SERVER_PUBLIC_URL`, `WIKI_ORIGIN`, and `PORT` already have correct local defaults.

### Path A: Nix (recommended)

The repo ships a `flake.nix` that provisions Postgres 16 (with pgvector), Redis, Node 22, and pnpm, fully isolated from anything on your system.

1. **Install Nix.** The [Determinate Systems installer](https://install.determinate.systems/) enables flakes by default and includes an uninstaller:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
   ```
   Restart your shell after.

2. **Enter the dev shell.** From the repo root:
   ```bash
   nix develop
   pnpm install
   ```
   First run takes 5–15 min to fetch and build the toolchain; subsequent shells are instant.

3. **Boot infra and apps.** Inside the shell:
   ```bash
   init        # postgres + redis (data lives in ./.dev/)
   start       # builds workspace packages, then launches core (:3000) + wiki (:8080)
   status      # health check
   logs [postgres|redis|core|wiki]
   stop        # stop core + wiki, keep infra running
   teardown    # stop everything
   ```

**Port conflicts:** if you already run Postgres locally (Postgres.app, Homebrew, Docker, etc.), `init` will refuse to start. Pick a free port and tell the flake about it before re-running:

```bash
export PG_PORT=5433
# update DATABASE_URL in core/.env to match: postgresql://postgres@127.0.0.1:5433/robinwiki
init
```

### Path B: Manual

Bring your own services.

**Prerequisites:**

- **Node.js** ≥ 20 (run `corepack enable` to pin pnpm via the `packageManager` field)
- **PostgreSQL** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **Redis** for the BullMQ job queue
- **An OpenRouter API key**, get one at [openrouter.ai/keys](https://openrouter.ai/keys)

**From clone to running:**

```bash
git clone https://github.com/withrobinhq/robinwiki.git
cd robinwiki
corepack enable
pnpm install

# After completing env file setup above:

# Make sure pgvector is enabled on your database
psql $DATABASE_URL -c 'CREATE EXTENSION IF NOT EXISTS vector;'

# Apply schema
pnpm --filter @robin/core db:push

# Start core API + wiki frontend in parallel
pnpm dev
```

Core runs on http://localhost:3000, wiki on http://localhost:8080. Log in with the `INITIAL_USERNAME` / `INITIAL_PASSWORD` you set above.

## Environment Variables

All variables live in `core/.env`. See `core/.env.example` for the canonical template.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | `postgresql://postgres@127.0.0.1:5432/robinwiki` | PostgreSQL connection string (must have pgvector) |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection string for BullMQ job queues |
| `BETTER_AUTH_SECRET` | Yes | — | Session cookie signing secret (32+ chars) |
| `MASTER_KEY` | Yes | — | Root encryption key, 64 hex chars (`openssl rand -hex 32`) |
| `KEY_ENCRYPTION_SECRET` | Yes | — | AES-256-GCM key encryption secret (32+ chars) |
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key for LLM calls and embeddings |
| `INITIAL_USERNAME` | Yes | — | Admin email address (created on first boot if no users exist) |
| `INITIAL_PASSWORD` | Yes | — | Admin password (rotate after first login) |
| `SERVER_PUBLIC_URL` | Yes | `http://localhost:3000` | Public URL for MCP endpoints + auth cookies. Bare domains auto-prepend `https://`. |
| `WIKI_ORIGIN` | Yes | `http://localhost:8080` | Wiki frontend URL(s) for CORS, comma-separated. Bare domains auto-prepend `https://`. |
| `PORT` | No | `3000` | HTTP listen port |
| `NODE_ENV` | No | `development` | `production` enables secure cookies |
| `LOG_LEVEL` | No | `info` | Pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) |
| `WIKI_CLASSIFY_THRESHOLD` | No | `0.65` | LLM confidence threshold for filing fragments (0.0–1.0) |
| `ENABLE_BATCH_REGEN` | No | `true` | Enable midnight batch wiki regeneration cron |

## Account password

Robin is single-user. Your password is set from `INITIAL_PASSWORD` on first boot — the env validator requires it to be at least 6 characters. Two ways to change it later:

- **Logged in:** open `/profile` → **Change password**. Uses better-auth's standard flow; you'll need your current password.
- **Locked out:** open `/recover` (public page). Paste the value of `BETTER_AUTH_SECRET` from your server env. The endpoint resets the account password to whatever `INITIAL_PASSWORD` is currently set to on the server — so to choose a new password this way: update `INITIAL_PASSWORD` on Railway, redeploy, then hit `/recover`.

## MCP Tools

Robin exposes an MCP server for Claude Desktop, ChatGPT, and other AI clients. The MCP layer is the canonical capture surface — anything the web UI can do, MCP can do, plus a few things only MCP can.

| Tool | Description |
|------|-------------|
| `log_entry` | Capture a thought — feeds the full 6-stage AI pipeline |
| `log_fragment` | Write a fragment directly to a known wiki (fast path) |
| `create_wiki` | Create a new wiki with auto-inferred type |
| `edit_wiki` | Update wiki content with edit history preservation |
| `list_wikis` | List all wikis with fragment counts and type info |
| `get_wiki` | Get wiki details with full body and fragment snippets |
| `get_fragment` | Get full fragment content by slug |
| `find_person` | Find a person by ID or fuzzy name search |
| `brief_person` | Get a formatted person briefing (no LLM call) |
| `search` | Hybrid BM25 + semantic search across all entities |
| `get_wiki_types` | List available wiki types and descriptors |
| `create_wiki_type` | Define a custom wiki type |
| `publish_wiki` | Publish a wiki with a stable public URL |
| `unpublish_wiki` | Unpublish a wiki (preserves slug for re-publish) |
| `get_timeline` | Audit timeline for a wiki and its fragments |
| `list_skills` | List skill wikis (the Capture pack and any user-authored skills) |

### Capture pack: installable Claude skills

The repo ships three Claude skills under `skills/` for use in any Claude client that supports project skills:

- `skills/log-to-robin-guide.md`: onboarding + reference for new Robin users; required reading before `create_wiki` calls.
- `skills/log-to-robin-short.md`: short-form capture (under ~2,000 words, clear attribution).
- `skills/log-to-robin-long.md`: long-form mining + curation. Pre-chunks long input into atomic `log_entry` calls (the server stays naive on entry size, by design).

To install: copy or symlink the three files into your Claude client's project skills directory (e.g. `.claude/skills/log-to-robin-guide/SKILL.md`). They are also discoverable at runtime via the `list_skills` MCP tool when stored as `skill`-typed wikis in your Robin instance.

Closes [#233](https://github.com/withrobinhq/robin/issues/233).

## API

The core server exposes a REST API alongside MCP. OpenAPI spec at:

```
GET http://localhost:3000/openapi.json
```

The wiki frontend uses a generated TypeScript client. Regenerate after API changes:

```bash
pnpm --filter @robin/wiki openapi:generate
```

## Scripts

### Root

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start all dev servers in parallel (Turborepo) |
| `pnpm build` | Build all workspaces |
| `pnpm typecheck` | Type-check all workspaces |
| `pnpm test` | Run tests across all workspaces |
| `pnpm lint` | Lint all workspaces |
| `pnpm format` | Format with Biome |
| `pnpm serve` | Start core + wiki with concurrently (alternative to `dev`) |
| `pnpm manifest` | Generate OpenAPI manifest and wiki client |

### Core (`@robin/core`)

| Script | Description |
|--------|-------------|
| `pnpm --filter @robin/core dev` | Start dev server with tsx watch |
| `pnpm --filter @robin/core build` | Compile TypeScript |
| `pnpm --filter @robin/core test` | Run Vitest tests |
| `pnpm --filter @robin/core db:generate` | Generate Drizzle migrations |
| `pnpm --filter @robin/core db:push` | Push schema to database |
| `pnpm --filter @robin/core mcp:inspect` | Launch MCP inspector |

### Wiki (`@robin/wiki`)

| Script | Description |
|--------|-------------|
| `pnpm --filter @robin/wiki dev` | Start Next.js dev server |
| `pnpm --filter @robin/wiki build` | Production build |
| `pnpm --filter @robin/wiki manifest` | Regenerate TypeScript client from OpenAPI spec |

## Contributing

### Workflow

Work on feature branches. Open a GitHub issue before starting non-trivial work, then a PR that references the issue.

### Workspace boundaries

The workspace packages (`@robin/agent`, `@robin/queue`, `@robin/shared`, `@robin/caslock`) have strict boundaries. Don't flatten them into core or merge packages together. Each package builds independently and exposes its own entry points.

### Linting and formatting

- **`core/` and `packages/`**: [Biome](https://biomejs.dev/) (`pnpm format`, `pnpm lint`)
- **`wiki/`**: [ESLint](https://eslint.org/) with `eslint-config-next` (wiki has its own config and does not use Biome)

## License

[MIT](LICENSE) © 2026 withrobinhq

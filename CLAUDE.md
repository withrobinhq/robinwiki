## Project

**Robin**

Robin is an AI-powered second brain that captures thoughts through conversation and structures them into a searchable knowledge base. Users interact with AI (via MCP or web UI), and Robin runs in the background to automatically extract atomic ideas (fragments), classify them into topic clusters (wikis), and store everything in a Postgres knowledge base. Every fragment, entry, and wiki is a text row in the database — there is no git-backed markdown store and no filesystem repo.

The `core/` workspace (`@robin/core`) is the sole application, owning all intelligence, auth, API, MCP, and AI pipeline responsibilities.

The `wiki/` workspace (`@robin/wiki`) is the web frontend — a Next.js 16 application with shadcn/ui, wired to the core API.

**Core Value:** Users can capture raw thoughts and have them automatically structured into searchable, interconnected knowledge — without manual organization.

### Constraints

- **No regressions**: Workspace package boundaries (`@robin/agent`, `@robin/queue`, `@robin/shared`, `@robin/caslock`) must be preserved exactly — no flattening
- **Single source**: Content lives in one canonical column per domain table; the edits table is an audit log, not a second store
- **Workspace layout**: `core/` and `packages/*` are top-level workspace entries, no `apps/` subdirectory
- **Wiki independence**: `wiki/` has its own tsconfig (bundler resolution) and eslint config (`eslint-config-next`). It does NOT extend `tsconfig.base.json` or use Biome.

## Technology Stack

| Layer | Stack |
|-------|-------|
| API | Hono, Zod, better-auth |
| Database | PostgreSQL + pgvector, Drizzle ORM |
| Queue | Redis + BullMQ |
| AI | OpenRouter (Claude, embeddings), Mastra |
| Frontend | Next.js 16, React 19, Tailwind CSS, shadcn/ui |
| Tooling | TypeScript, Biome, Vitest, Turborepo, pnpm |

## Conventions

- **Monorepo**: pnpm workspaces + Turborepo. `core/`, `wiki/`, and `packages/*` are the workspace entries.
- **Linting & formatting**: Biome for `core/` and `packages/*` (`pnpm format`, `pnpm lint`); ESLint with `eslint-config-next` for `wiki/` (its own config, no Biome).
- **Tests**: Vitest across `core/` and `packages/*`. Run with `pnpm test`.
- **Type checking**: `pnpm typecheck` runs across all workspaces.
- **Commits**: Conventional Commits (`feat`, `fix`, `chore`, `docs`, `refactor`, …). Work on feature branches; open an issue before non-trivial work, then a PR referencing it.
- **Soft delete**: rows carry a `deleted_at` column; read paths filter `deleted_at IS NULL` rather than hard-deleting.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full system overview — the ingest pipeline, data model, hybrid search, MCP surface, auth, wiki state machine, and background workers.

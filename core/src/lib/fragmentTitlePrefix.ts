/**
 * #239 — Re-export of the canonical fragment title-prefix helper.
 *
 * The implementation lives in `@robin/shared` so that the worker pipeline
 * (`packages/agent`), HTTP routes (`core/src/routes`), and MCP handlers
 * (`core/src/mcp`) can share a single source of truth. Core code imports
 * via this module so an in-package path (`../lib/...`) keeps working
 * alongside the workspace import.
 */
export {
  applyFragmentTitleDatePrefix,
  utcYymmdd,
} from '@robin/shared'

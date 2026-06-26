// Default-deny route audit (source-scan).
//
// Parses core/src/index.ts as a string and asserts every top-level
// app.{route,get,post,put,delete,patch,use} mount is either:
//   (a) listed in this file's PUBLIC_ROUTES allowlist,
//   (b) preceded in index.ts by `app.use('<path>/*', sessionMiddleware)`, or
//   (c) self-gated inside its routes module via `<router>.use('*', ...)`
//       where the inner middleware is sessionMiddleware OR a custom auth
//       (e.g. mcp.ts verifies its own MCP token).
//
// Why source-scan and not Hono runtime introspection: extracting a
// buildApp() factory from index.ts is structural surgery on the boot
// file. This test catches the regression we care about (accidental new
// public route) without touching production bootstrap code.
//
// Known gap: this test does NOT verify middleware ORDER on the chain.
// It only verifies that an auth middleware appears somewhere in the
// mount surface. Order regressions are caught by integration tests
// (bull-board-auth.test.ts, phase2-uat.integration.test.ts).
//
// PUBLIC_ROUTES below mirrors core/src/bootstrap/assert-prod-safety.ts
// PUBLIC_ROUTES. Mirroring (not importing) is intentional — if the test
// imported the constant, drift between the constant and reality would
// be invisible. By hardcoding here, the production-side PUBLIC_ROUTES
// is treated as the thing under test.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE_SRC = resolve(__dirname, '..')
const INDEX_PATH = resolve(CORE_SRC, 'index.ts')

// Hardcoded mirror of core/src/bootstrap/assert-prod-safety.ts PUBLIC_ROUTES.
// Intentional duplication — see file header.
const PUBLIC_ROUTES = [
  '/',
  '/health',
  '/openapi.json',
  '/favicon.ico',
  '/system/status',
  '/published/wiki/:nanoid',
  '/auth/recover',
  '/api/auth/*',
] as const

function isPublic(path: string): boolean {
  for (const p of PUBLIC_ROUTES) {
    if (p === path) return true
    if (p.endsWith('/*') && path.startsWith(p.slice(0, -2))) return true
    // /published is mounted via app.route('/published', publishedRoutes)
    // so the bare '/published' path appears as a route mount; treat the
    // canonical /published/wiki/:nanoid entry as covering the prefix.
    if (p === '/published/wiki/:nanoid' && path === '/published') return true
    // Same for /system → /system/status.
    if (p === '/system/status' && path === '/system') return true
    // Same for /auth → /auth/recover.
    if (p === '/auth/recover' && path === '/auth') return true
  }
  return false
}

// Strip `// ...` line comments so regex matches on actual code, not
// commented-out mount lines (e.g. `// app.route('/internal', internalRoutes)`
// — a dormant route). Block comments are deliberately NOT stripped because
// path strings like `'/admin/queues/*'` contain `/*` that would otherwise
// fool a naive `/\* ... \*/` regex.
function stripLineComments(src: string): string {
  // Walk line by line so we never cross a string boundary.
  return src
    .split('\n')
    .map((line) => {
      // Find // not inside a string. Conservative: only strip when the //
      // appears after the start of the line and not preceded by ":" (URL
      // case like `https://`) or by an unclosed quote.
      const idx = findLineCommentStart(line)
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

function findLineCommentStart(line: string): number {
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i]
    const next = line[i + 1]
    if (!inDouble && !inBacktick && ch === "'") inSingle = !inSingle
    else if (!inSingle && !inBacktick && ch === '"') inDouble = !inDouble
    else if (!inSingle && !inDouble && ch === '`') inBacktick = !inBacktick
    else if (
      !inSingle &&
      !inDouble &&
      !inBacktick &&
      ch === '/' &&
      next === '/' &&
      line[i - 1] !== ':'
    ) {
      return i
    }
  }
  return -1
}

describe('default-deny route audit (source-scan)', () => {
  const indexSrc = stripLineComments(readFileSync(INDEX_PATH, 'utf8'))

  // Parse `app.route('/x', xRoutes)` — captures path AND module identifier
  // so the routes-module file can be resolved for self-gate detection.
  const routeMountRegex = /app\.route\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g
  const routeMounts: { path: string; ident: string }[] = []
  for (const m of indexSrc.matchAll(routeMountRegex)) {
    routeMounts.push({ path: m[1], ident: m[2] })
  }

  // Parse `app.{get,post,put,delete,patch}('/x', ...)` — inline handlers.
  // No module identifier; classified against PUBLIC_ROUTES + indexGatedPrefixes.
  const verbMountRegex = /app\.(?:get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g
  const verbMounts: string[] = []
  for (const m of indexSrc.matchAll(verbMountRegex)) {
    verbMounts.push(m[1])
  }

  // Parse `app.use('/x/*', ...)` — index-level gates that protect a prefix.
  // We only care about those that thread sessionMiddleware (or auth.handler
  // for /api/auth/*, which is its own public surface managed by better-auth).
  const gateRegex = /app\.use\(\s*['"`]([^'"`]+?)\/\*['"`]\s*,\s*sessionMiddleware\b/g
  const indexGatedPrefixes = new Set<string>()
  for (const m of indexSrc.matchAll(gateRegex)) {
    indexGatedPrefixes.add(m[1])
  }

  // Resolve a routes-module file by scanning index.ts imports for the ident.
  function resolveModulePath(ident: string): string | null {
    const importRegex = new RegExp(
      `import\\s+(?:(?:\\*\\s+as\\s+${ident})|(?:\\{[^}]*\\b${ident}\\b[^}]*\\})|(?:${ident}\\b))[^'"\`]*from\\s+['"\`]([^'"\`]+)['"\`]`
    )
    const m = importRegex.exec(indexSrc)
    if (!m) return null
    const rel = m[1].replace(/\.js$/, '.ts')
    return resolve(CORE_SRC, rel)
  }

  // Module is self-gated if it contains `<router>.use('*', ...)` where the
  // body either references sessionMiddleware OR is a custom inline auth
  // function (mcp's verifyMcpToken). We intentionally accept both shapes —
  // the test asserts SOME middleware is applied to all routes, not that it
  // is specifically sessionMiddleware.
  function moduleSelfGates(modulePath: string): boolean {
    const src = readFileSync(modulePath, 'utf8')
    if (/\.use\(\s*['"`]\*?\/?\*['"`]\s*,\s*sessionMiddleware\b/.test(src)) return true
    // mcp.ts shape: `mcp.use('*', async (c, next) => { ... verifyMcpToken ... })`.
    if (/\.use\(\s*['"`]\*['"`]\s*,\s*async\b[\s\S]{0,200}?verifyMcpToken/.test(src)) return true
    return false
  }

  it('every app.route mount is public, index-gated, or self-gated', () => {
    const offenders: string[] = []

    for (const { path, ident } of routeMounts) {
      if (isPublic(path)) continue
      if (indexGatedPrefixes.has(path)) continue

      const modPath = resolveModulePath(ident)
      if (modPath && moduleSelfGates(modPath)) continue

      offenders.push(`${path} (mounted via ${ident})`)
    }

    expect(offenders, `unauthed app.route mounts detected:\n${offenders.join('\n')}`).toEqual([])
  })

  it('every app.{get,post,put,delete,patch} mount is public or index-gated', () => {
    const offenders: string[] = []

    for (const path of verbMounts) {
      if (isPublic(path)) continue
      if (indexGatedPrefixes.has(path)) continue
      // Verb mounts are inline handlers — no self-gating module to check.
      offenders.push(`${path} (verb mount)`)
    }

    expect(offenders, `unauthed verb mounts detected:\n${offenders.join('\n')}`).toEqual([])
  })

  it('PUBLIC_ROUTES allowlist is non-empty and well-formed', () => {
    expect(PUBLIC_ROUTES.length).toBeGreaterThan(0)
    for (const p of PUBLIC_ROUTES) {
      expect(p.startsWith('/')).toBe(true)
    }
  })

  it('regex parses at least one mount from index.ts (sanity check)', () => {
    expect(routeMounts.length + verbMounts.length).toBeGreaterThan(0)
  })

  it('admin routes self-gate inside their module', () => {
    const adminPath = resolve(CORE_SRC, 'routes/admin.ts')
    const src = readFileSync(adminPath, 'utf8')
    expect(/adminRoutes\.use\(\s*['"`]\*['"`]\s*,\s*sessionMiddleware\b/.test(src)).toBe(true)
  })

  it('/admin/queues/* is index-gated by sessionMiddleware', () => {
    expect(indexGatedPrefixes.has('/admin/queues')).toBe(true)
  })
})

describe('CORS strict-mode in production rejects unknown origins', () => {
  const indexSrc = stripLineComments(readFileSync(INDEX_PATH, 'utf8'))

  it('isProd branch denies origins outside the allowlist', () => {
    // Source-scan rather than runtime: the cors mount uses a `(origin) => ...`
    // function that returns null when the origin is not in the allowlist.
    // We assert the literal shape so a future refactor that drops the
    // strict-deny branch trips this test.
    expect(indexSrc).toMatch(/if\s*\(!isProd\)\s*return\s+origin/)
    expect(indexSrc).toMatch(/return\s+getAllowedOrigins\(\)\.has\(origin\)\s*\?\s*origin\s*:\s*null/)
  })
})

describe('BullBoard route applies session middleware', () => {
  const indexSrc = stripLineComments(readFileSync(INDEX_PATH, 'utf8'))

  it("app.use('/admin/queues/*', sessionMiddleware) precedes the bull-board mount", () => {
    const gateIdx = indexSrc.indexOf("app.use('/admin/queues/*', sessionMiddleware)")
    const mountIdx = indexSrc.indexOf("app.route('/admin/queues', bullBoardApp)")
    expect(gateIdx).toBeGreaterThan(-1)
    expect(mountIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(mountIdx)
  })
})

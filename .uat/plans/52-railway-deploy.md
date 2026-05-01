# UAT 52 — Railway Deploy Config

## Purpose

Verify that Railway deploy of `withrobinhq/robinwiki` is unblocked by:

1. Existence of `railpack.core.json` + `railpack.wiki.json` (the per-service build configs Railway pulls from the repo)
2. Structural shape of railpack configs matches what Railway expects (provider, node major, deploy startCommand)
3. Pinned package manager + node engine in `package.json` still match what railpack hard-codes

## Pre-conditions

- `PROJECT_ROOT` env var points at the worktree root
- `jq` available

## Notes (pragmatism)

- `railway.template.json` is no longer in the repo — the template has been **published directly on Railway** (operators use the `Deploy on Railway` README button, which links to the published template registry). The per-service railpack configs still need to live in the repo because Railway clones the repo and uses them as the build manifest. If the published template is ever migrated back to file-based, this plan should be amended to re-assert template shape in §0.
- We do NOT assert on the EXACT runtime image tag (`mise-2026.3.17`) or the EXACT shim paths (`/mise/shims/node`) beyond the binary suffix — those upstream values may evolve.
  - If Railway upstream changes the runtime base image, the §3 schema URL or §5 startCommand binary check may need tightening or loosening — update those assertions.
- Caslock is loaded at runtime by `core/src/db/locks.ts` — its `node_modules` MUST be in the deploy include list for core, otherwise the runtime crashes on import. This is the one drift from builder-25/robinwiki's working config.
- `engines.node >= 20.0.0` and `packageManager == pnpm@10.15.1` are pinned in BOTH the root `package.json` AND the railpack files. If they drift in the future, both must be updated together — surface as a §6 assertion.

## Test plan

```bash
set -u
cd "${PROJECT_ROOT:?PROJECT_ROOT must be set}"
PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "P: $1"; }
fail() { FAIL=$((FAIL+1)); echo "F: $1"; }

# §1 — Files exist at repo root
for f in railpack.core.json railpack.wiki.json; do
  if [ -f "$f" ]; then pass "$f exists"; else fail "$f missing"; fi
done

# §2 — Each is valid JSON
for f in railpack.core.json railpack.wiki.json; do
  if [ -f "$f" ] && jq . "$f" >/dev/null 2>&1; then
    pass "$f is valid JSON"
  else
    fail "$f invalid JSON or missing"
  fi
done

# §3 — Schema URLs are Railway schema URLs
for f in railpack.core.json railpack.wiki.json; do
  if [ -f "$f" ]; then
    schema=$(jq -r '."$schema" // empty' "$f")
    if echo "$schema" | grep -Eq 'schema\.railpack\.com'; then
      pass "$f schema URL is railway schema ($schema)"
    else
      fail "$f schema URL is not railway schema (got: $schema)"
    fi
  fi
done

# §4 — (removed) railway.template.json shape — template now published on Railway directly

# §5 — railpack config structural shape
if [ -f railpack.core.json ]; then
  prov=$(jq -r '.provider // empty' railpack.core.json)
  node=$(jq -r '.packages.node // empty' railpack.core.json)
  install_cmd=$(jq -r '.steps.install.commands | join(" ")' railpack.core.json)
  caslock_in_deploy=$(jq -r '.deploy.inputs[] | select(.step == "install") | .include[] | select(. == "packages/caslock/node_modules")' railpack.core.json)
  start=$(jq -r '.deploy.startCommand // empty' railpack.core.json)

  if [ "$prov" = "node" ]; then pass "railpack.core.json provider == node"; else fail "railpack.core.json provider is '$prov'"; fi
  if [ "$node" = "22" ]; then pass "railpack.core.json packages.node == 22"; else fail "railpack.core.json packages.node is '$node'"; fi
  if echo "$install_cmd" | grep -q "pnpm install"; then pass "railpack.core.json install step has 'pnpm install'"; else fail "railpack.core.json install step missing 'pnpm install'"; fi
  if [ "$caslock_in_deploy" = "packages/caslock/node_modules" ]; then
    pass "railpack.core.json deploy includes packages/caslock/node_modules"
  else
    fail "railpack.core.json deploy MISSING packages/caslock/node_modules in install include"
  fi
  if [ "$start" = "/mise/shims/node core/dist/index.js" ]; then
    pass "railpack.core.json deploy.startCommand == /mise/shims/node core/dist/index.js"
  else
    fail "railpack.core.json deploy.startCommand is '$start'"
  fi
fi

if [ -f railpack.wiki.json ]; then
  prov=$(jq -r '.provider // empty' railpack.wiki.json)
  node=$(jq -r '.packages.node // empty' railpack.wiki.json)
  start=$(jq -r '.deploy.startCommand // empty' railpack.wiki.json)

  if [ "$prov" = "node" ]; then pass "railpack.wiki.json provider == node"; else fail "railpack.wiki.json provider is '$prov'"; fi
  if [ "$node" = "22" ]; then pass "railpack.wiki.json packages.node == 22"; else fail "railpack.wiki.json packages.node is '$node'"; fi
  if echo "$start" | grep -q 'next start -p \$PORT'; then
    pass "railpack.wiki.json deploy.startCommand contains 'next start -p \$PORT'"
  else
    fail "railpack.wiki.json deploy.startCommand is '$start'"
  fi
fi

# §6 — package.json engines + packageManager still align with railpack pins
if [ -f package.json ]; then
  pkg_node=$(jq -r '.engines.node // empty' package.json)
  pkg_pnpm=$(jq -r '.packageManager // empty' package.json)
  if [ "$pkg_node" = ">=20.0.0" ]; then
    pass "package.json engines.node == >=20.0.0 (satisfies railpack node:22)"
  else
    fail "package.json engines.node is '$pkg_node' (railpack pins node:22 — must satisfy)"
  fi
  if [ "$pkg_pnpm" = "pnpm@10.15.1" ]; then
    pass "package.json packageManager == pnpm@10.15.1 (matches railpack corepack prepare)"
  else
    fail "package.json packageManager is '$pkg_pnpm' (railpack pins pnpm@10.15.1 — drift)"
  fi
fi

echo
echo "===== UAT 52 result ====="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[ "$FAIL" = "0" ] || exit 1
```

## Open questions

- After Railway provisions the template, a manual `CREATE EXTENSION IF NOT EXISTS vector;` is still required on Postgres before the core service can run migrations that depend on pgvector. This UAT does not cover that — it's a post-deploy step documented in the template's `readme`.
- Several env vars are `description`-only with no default (`BETTER_AUTH_SECRET`, `MASTER_KEY`, `KEY_ENCRYPTION_SECRET`, `OPENROUTER_API_KEY`, `INITIAL_USERNAME`, `INITIAL_PASSWORD`, `SERVER_PUBLIC_URL`, `WIKI_ORIGIN`). Railway will require these to be filled by the operator at first deploy, otherwise core will crash on boot. Out of scope for this plan.
- The `provision` worker (memory note: "MCP broken (missing provision worker)") is not addressed by this fix. Railway will start core fine, but MCP routes that require the provision worker will still fail until that worker is shipped.

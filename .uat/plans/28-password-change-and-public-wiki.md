# 28 — Password Change Flow + Public Wiki Page

## What it proves
PR #191 ships two PO-blocking features: (1) authenticated users can rotate their password from the profile page via better-auth's `change-password` endpoint — the new password works for sign-in, the old one stops working, the `accounts.password` hash mutates, and a wrong `currentPassword` is rejected without mutating the DB; (2) a published wiki is reachable as a rendered HTML article at `$WIKI_URL/p/<nanoid>` (no cookie required), the same nanoid resolves on the JSON API at `$SERVER_URL/published/wiki/<nanoid>`, OG metadata is embedded in the page source, and an unpublished wiki returns 404 on both surfaces. Mutating endpoints on a published wiki still require auth — anon `POST /wikis/:id/unpublish` returns 401.

The plan ends by restoring the password to `$INITIAL_PASSWORD` so subsequent UAT runs are not locked out. This restore step is mandatory.

## Prerequisites
- Core server on `SERVER_URL` (default `http://localhost:3000`).
- Wiki dev/prod server on `WIKI_URL` (default `http://localhost:8080`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `DATABASE_URL` reachable for password-hash inspection (assertion is skipped if unset).
- `pnpm -C core seed-fixture` has been run (UAT publishes the Transformer demo wiki).

## Endpoint map (PR #191)
- `POST /api/auth/sign-in/email` — better-auth (existing).
- `POST /api/auth/change-password` — better-auth built-in. Body: `{ currentPassword, newPassword }`. 401 on bad current.
- `POST /wikis/:id/publish` — auth required. Returns `{ published, publishedSlug, publishedAt, regenerate }`.
- `POST /wikis/:id/unpublish` — auth required.
- `GET  /published/wiki/:nanoid` — **no auth**. 404 when slug missing or `published=false`. JSON body.
- `GET  $WIKI_URL/p/<nanoid>` — **no auth**. Next.js (public) segment. SSR fetches the JSON above and renders the article. 404 page when JSON returns 404.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"

# Two cookie jars: OLD_JAR holds the session signed in with the original
# password; NEW_JAR is empty until step 4 signs in with the new password.
OLD_JAR=$(mktemp /tmp/uat-28-old-XXXXXX.txt)
NEW_JAR=$(mktemp /tmp/uat-28-new-XXXXXX.txt)
ANON_JAR=/dev/null  # never used — anon requests carry no cookie
trap 'rm -f "$OLD_JAR" "$NEW_JAR" /tmp/uat-28-*.json /tmp/uat-28-*.html /tmp/uat-28-*.png' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

# Distinct UAT-only password — long enough to survive any future policy gate.
NEW_PASSWORD="uat28-rotated-$(date +%s)-A1!"
WRONG_PASSWORD="not-the-current-password-x9q"

echo "28 — Password Change + Public Wiki"
echo ""

# ── 1. Sign in with INITIAL_PASSWORD (baseline session) ───────────
SIGNIN_HTTP=$(curl -s -o /tmp/uat-28-signin.json -w "%{http_code}" \
  -c "$OLD_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email")

if [ "$SIGNIN_HTTP" = "200" ]; then
  pass "1a. baseline sign-in with INITIAL_PASSWORD → 200"
else
  fail "1a. baseline sign-in failed (HTTP $SIGNIN_HTTP) — cannot proceed"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# Snapshot the password hash BEFORE rotation so we can prove it changed.
HASH_BEFORE=""
if [ -n "${DATABASE_URL:-}" ]; then
  HASH_BEFORE=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT md5(coalesce(a.password,'')) FROM accounts a JOIN users u ON a.user_id = u.id WHERE u.email = '${INITIAL_USERNAME}' LIMIT 1;" 2>/dev/null || true)
  if [ -n "$HASH_BEFORE" ]; then
    pass "1b. captured md5(password-hash) before rotation"
  else
    skip "1b. could not read accounts.password (no rows or psql access)"
  fi
else
  skip "1b. DATABASE_URL not set — hash-mutation assertion will be skipped"
fi

# ── 2. Negative: change-password with WRONG currentPassword → 401, no mutation ──
WRONG_HTTP=$(curl -s -o /tmp/uat-28-wrong.json -w "%{http_code}" \
  -b "$OLD_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"currentPassword\":\"$WRONG_PASSWORD\",\"newPassword\":\"$NEW_PASSWORD\"}" \
  "$SERVER_URL/api/auth/change-password")

# better-auth returns 400/401 for invalid password. Accept either; reject 200.
if [ "$WRONG_HTTP" = "401" ] || [ "$WRONG_HTTP" = "400" ]; then
  pass "2a. wrong currentPassword rejected (HTTP $WRONG_HTTP)"
elif [ "$WRONG_HTTP" = "200" ]; then
  fail "2a. wrong currentPassword returned 200 — auth bypass!"
else
  fail "2a. wrong currentPassword returned unexpected HTTP $WRONG_HTTP"
fi

# Hash must NOT have changed after a rejected change-password.
if [ -n "${DATABASE_URL:-}" ] && [ -n "$HASH_BEFORE" ]; then
  HASH_AFTER_WRONG=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT md5(coalesce(a.password,'')) FROM accounts a JOIN users u ON a.user_id = u.id WHERE u.email = '${INITIAL_USERNAME}' LIMIT 1;" 2>/dev/null || true)
  if [ "$HASH_AFTER_WRONG" = "$HASH_BEFORE" ]; then
    pass "2b. accounts.password hash unchanged after rejected change"
  else
    fail "2b. accounts.password hash mutated despite 401 — DB integrity violation"
  fi
else
  skip "2b. hash-mutation check skipped (no DB access)"
fi

# Original password still signs in.
RESIGNIN_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -c /tmp/uat-28-resignin.txt -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
rm -f /tmp/uat-28-resignin.txt
if [ "$RESIGNIN_HTTP" = "200" ]; then
  pass "2c. INITIAL_PASSWORD still works after rejected change"
else
  fail "2c. INITIAL_PASSWORD broken after rejected change (HTTP $RESIGNIN_HTTP)"
fi

# ── 3. Negative: anonymous change-password → 401 ──────────────────
ANON_CHG_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"currentPassword\":\"${INITIAL_PASSWORD:-}\",\"newPassword\":\"$NEW_PASSWORD\"}" \
  "$SERVER_URL/api/auth/change-password")
if [ "$ANON_CHG_HTTP" = "401" ]; then
  pass "3. anonymous change-password → 401"
else
  fail "3. anonymous change-password returned HTTP $ANON_CHG_HTTP (expected 401)"
fi

# ── 4. Positive: change-password with correct currentPassword ─────
CHG_HTTP=$(curl -s -o /tmp/uat-28-chg.json -w "%{http_code}" \
  -b "$OLD_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"currentPassword\":\"${INITIAL_PASSWORD:-}\",\"newPassword\":\"$NEW_PASSWORD\"}" \
  "$SERVER_URL/api/auth/change-password")

if [ "$CHG_HTTP" = "200" ]; then
  pass "4a. change-password with valid currentPassword → 200"
else
  fail "4a. change-password failed (HTTP $CHG_HTTP) body=$(head -c 200 /tmp/uat-28-chg.json)"
fi

# Hash must have changed.
if [ -n "${DATABASE_URL:-}" ] && [ -n "$HASH_BEFORE" ]; then
  HASH_AFTER=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT md5(coalesce(a.password,'')) FROM accounts a JOIN users u ON a.user_id = u.id WHERE u.email = '${INITIAL_USERNAME}' LIMIT 1;" 2>/dev/null || true)
  if [ -n "$HASH_AFTER" ] && [ "$HASH_AFTER" != "$HASH_BEFORE" ]; then
    pass "4b. accounts.password hash rotated (md5 differs)"
  else
    fail "4b. accounts.password hash unchanged after successful change"
  fi
else
  skip "4b. hash-mutation check skipped (no DB access)"
fi

# Old password should NO LONGER sign in.
OLDPW_SIGNIN_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -c /tmp/uat-28-oldpw.txt -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
rm -f /tmp/uat-28-oldpw.txt
if [ "$OLDPW_SIGNIN_HTTP" = "401" ] || [ "$OLDPW_SIGNIN_HTTP" = "400" ] || [ "$OLDPW_SIGNIN_HTTP" = "403" ]; then
  pass "4c. INITIAL_PASSWORD rejected after rotation (HTTP $OLDPW_SIGNIN_HTTP)"
else
  fail "4c. INITIAL_PASSWORD still accepted after rotation (HTTP $OLDPW_SIGNIN_HTTP)"
fi

# New password signs in into a fresh cookie jar.
NEWPW_SIGNIN_HTTP=$(curl -s -o /tmp/uat-28-newpw.json -w "%{http_code}" \
  -c "$NEW_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"$NEW_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$NEWPW_SIGNIN_HTTP" = "200" ]; then
  pass "4d. new password signs in successfully → 200"
else
  fail "4d. new password sign-in failed (HTTP $NEWPW_SIGNIN_HTTP)"
fi

# Authed call with NEW_JAR should succeed.
PROF_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$NEW_JAR" -H "Origin: $ORIGIN" "$SERVER_URL/users/profile")
[ "$PROF_HTTP" = "200" ] && pass "4e. authenticated /users/profile via new session → 200" \
                        || fail "4e. /users/profile via new session returned HTTP $PROF_HTTP"

# ── 5. Publish a wiki to exercise the public surface ──────────────
WIKIS_LIST=$(curl -s -b "$NEW_JAR" -H "Origin: $ORIGIN" "$SERVER_URL/wikis?limit=50")
TARGET_KEY=$(echo "$WIKIS_LIST" | jq -r '
  ([.wikis[]? | select(.slug == "transformer-architecture")][0]
   // [.wikis[]? | select((.content // "") != "")][0]
   // .wikis[0]
  ).lookupKey // empty')

if [ -z "${TARGET_KEY:-}" ]; then
  fail "5a. No wikis available to publish — seed-fixture must run before this plan"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
pass "5a. selected wiki to publish (key=${TARGET_KEY:0:16}...)"

PUB_HTTP=$(curl -s -o /tmp/uat-28-pub.json -w "%{http_code}" \
  -b "$NEW_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  "$SERVER_URL/wikis/$TARGET_KEY/publish")

if [ "$PUB_HTTP" = "200" ]; then
  pass "5b. POST /wikis/$TARGET_KEY/publish → 200"
else
  fail "5b. publish failed (HTTP $PUB_HTTP) body=$(head -c 200 /tmp/uat-28-pub.json)"
fi

PUB_SLUG=$(jq -r '.publishedSlug // empty' /tmp/uat-28-pub.json)
PUB_FLAG=$(jq -r '.published // false' /tmp/uat-28-pub.json)

if [ -n "$PUB_SLUG" ] && [ "$PUB_SLUG" != "null" ]; then
  pass "5c. publish response carries publishedSlug ($PUB_SLUG)"
else
  fail "5c. publish response missing publishedSlug"
  PUB_SLUG=""
fi

[ "$PUB_FLAG" = "true" ] && pass "5d. publish response carries published=true" \
                        || fail "5d. publish response published=$PUB_FLAG (expected true)"

# /wikis/:id should reflect published=true on subsequent GET (PR #191 added the field to wikiResponseSchema).
DETAIL_AFTER_PUB=$(curl -s -b "$NEW_JAR" -H "Origin: $ORIGIN" "$SERVER_URL/wikis/$TARGET_KEY")
DETAIL_PUBLISHED=$(echo "$DETAIL_AFTER_PUB" | jq -r '.published // false')
DETAIL_PUB_SLUG=$(echo "$DETAIL_AFTER_PUB" | jq -r '.publishedSlug // empty')
[ "$DETAIL_PUBLISHED" = "true" ] && pass "5e. GET /wikis/<key> shows published=true after publish" \
                                || fail "5e. GET /wikis/<key> published=$DETAIL_PUBLISHED (expected true)"
[ "$DETAIL_PUB_SLUG" = "$PUB_SLUG" ] && pass "5f. GET /wikis/<key> publishedSlug matches publish-response slug" \
                                    || fail "5f. publishedSlug mismatch (response=$PUB_SLUG, detail=$DETAIL_PUB_SLUG)"

# ── 6. Public JSON surface — no auth required ─────────────────────
if [ -z "$PUB_SLUG" ]; then
  skip "6. public JSON checks skipped (no slug)"
else
  ANON_JSON_HTTP=$(curl -s -o /tmp/uat-28-anon.json -w "%{http_code}" \
    "$SERVER_URL/published/wiki/$PUB_SLUG")
  [ "$ANON_JSON_HTTP" = "200" ] && pass "6a. anon GET /published/wiki/$PUB_SLUG → 200" \
                              || fail "6a. anon GET returned HTTP $ANON_JSON_HTTP"

  # Body must include name, content, publishedAt, refs/sections/infobox keys.
  for FIELD in name content publishedAt refs sections; do
    HAS=$(jq "has(\"$FIELD\")" /tmp/uat-28-anon.json 2>/dev/null)
    if [ "$HAS" = "true" ]; then
      pass "6b. anon JSON has '$FIELD' field"
    else
      fail "6b. anon JSON missing '$FIELD' field"
    fi
  done

  ANON_NAME=$(jq -r '.name // ""' /tmp/uat-28-anon.json)
  if [ -n "$ANON_NAME" ] && [ "$ANON_NAME" != "null" ]; then
    pass "6c. anon JSON name non-empty ($ANON_NAME)"
  else
    fail "6c. anon JSON name empty"
  fi
fi

# ── 7. Public Next.js page — no auth required ─────────────────────
if [ -z "$PUB_SLUG" ]; then
  skip "7. public page checks skipped (no slug)"
else
  ANON_PAGE_HTTP=$(curl -s -o /tmp/uat-28-page.html -w "%{http_code}" \
    "$WIKI_URL/p/$PUB_SLUG")
  [ "$ANON_PAGE_HTTP" = "200" ] && pass "7a. anon GET $WIKI_URL/p/$PUB_SLUG → 200" \
                              || fail "7a. anon GET page returned HTTP $ANON_PAGE_HTTP"

  # Body should be HTML with the wiki name visible.
  if grep -qF "$ANON_NAME" /tmp/uat-28-page.html; then
    pass "7b. rendered page contains wiki name '$ANON_NAME'"
  else
    fail "7b. rendered page missing wiki name"
  fi

  # OG metadata in page <head>.
  if grep -qiE 'property="og:title"' /tmp/uat-28-page.html; then
    pass "7c. og:title meta present in page source"
  else
    fail "7c. og:title meta missing"
  fi

  if grep -qiE 'property="og:type"[^>]*content="article"' /tmp/uat-28-page.html \
    || grep -qiE 'name="og:type"[^>]*content="article"' /tmp/uat-28-page.html; then
    pass "7d. og:type=article meta present"
  else
    fail "7d. og:type=article meta missing"
  fi

  # Footer marker from PublishedWikiArticle.
  if grep -qF "Powered by Robin Wiki" /tmp/uat-28-page.html \
    || grep -qF "Robin Wiki" /tmp/uat-28-page.html; then
    pass "7e. 'Robin Wiki' branding present in rendered page"
  else
    fail "7e. 'Robin Wiki' branding absent"
  fi

  # Negative: no auth-only chrome should leak (no sidebar/profile links).
  if grep -qiE 'href="/profile"|data-slot="sidebar"' /tmp/uat-28-page.html; then
    fail "7f. authenticated chrome leaked into public page"
  else
    pass "7f. no authenticated chrome in public page"
  fi
fi

# ── 8. Negative: unpublished + anon mutation ──────────────────────
if [ -z "$PUB_SLUG" ]; then
  skip "8. unpublish/anon-mutation checks skipped (no slug)"
else
  # 8a. anon attempt to unpublish should fail with 401 (mutating endpoint).
  ANON_UNPUB_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST -H "Origin: $ORIGIN" "$SERVER_URL/wikis/$TARGET_KEY/unpublish")
  [ "$ANON_UNPUB_HTTP" = "401" ] && pass "8a. anon POST /wikis/<key>/unpublish → 401" \
                                || fail "8a. anon unpublish returned HTTP $ANON_UNPUB_HTTP (expected 401)"

  # 8b. authed unpublish.
  UNPUB_HTTP=$(curl -s -o /tmp/uat-28-unpub.json -w "%{http_code}" \
    -b "$NEW_JAR" -X POST -H "Origin: $ORIGIN" "$SERVER_URL/wikis/$TARGET_KEY/unpublish")
  [ "$UNPUB_HTTP" = "200" ] && pass "8b. authed unpublish → 200" \
                            || fail "8b. authed unpublish returned HTTP $UNPUB_HTTP"

  # 8c. anon JSON surface now returns 404 (wiki.published=false).
  ANON_AFTER_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    "$SERVER_URL/published/wiki/$PUB_SLUG")
  [ "$ANON_AFTER_HTTP" = "404" ] && pass "8c. anon /published/wiki/<slug> on unpublished wiki → 404" \
                                || fail "8c. anon JSON returned HTTP $ANON_AFTER_HTTP after unpublish (expected 404)"

  # 8d. anon page now shows Next.js notFound (Next returns 404 for notFound()).
  ANON_PAGE_AFTER_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    "$WIKI_URL/p/$PUB_SLUG")
  if [ "$ANON_PAGE_AFTER_HTTP" = "404" ]; then
    pass "8d. anon page on unpublished wiki → 404"
  else
    fail "8d. anon page returned HTTP $ANON_PAGE_AFTER_HTTP (expected 404)"
  fi

  # 8e. anon GET on a bogus slug → 404 (covers the "no row" branch).
  ANON_BOGUS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    "$SERVER_URL/published/wiki/bogus-slug-does-not-exist-xyz")
  [ "$ANON_BOGUS_HTTP" = "404" ] && pass "8e. anon /published/wiki/<bogus> → 404" \
                                || fail "8e. bogus slug returned HTTP $ANON_BOGUS_HTTP"
fi

# ── 9. Frontend smoke — Profile → Security → Change password ──────
# Optional UI flow. We've already proven the API end-to-end above; this
# verifies the form is wired to the same endpoint and the success path
# clears the inputs. SKIPS if agent-browser isn't available.

if command -v npx >/dev/null 2>&1 && npx --no -- agent-browser --help >/dev/null 2>&1; then
  npx agent-browser open "$WIKI_URL/login" 2>/dev/null
  npx agent-browser wait --load networkidle
  npx agent-browser fill '#email' "${INITIAL_USERNAME:-}"
  npx agent-browser fill '#password' "$NEW_PASSWORD"
  npx agent-browser click 'button[type="submit"]'
  npx agent-browser wait --load networkidle

  npx agent-browser open "$WIKI_URL/profile" 2>/dev/null
  npx agent-browser wait --load networkidle
  PROFILE_SNAP=$(npx agent-browser snapshot 2>/dev/null)
  npx agent-browser screenshot /tmp/uat-28-09-profile.png 2>/dev/null

  if echo "$PROFILE_SNAP" | grep -qi "Security" \
     && echo "$PROFILE_SNAP" | grep -qi "Change password"; then
    pass "9a. Profile page renders Security → Change password section"
  else
    fail "9a. Profile page missing Security / Change password section"
  fi

  if echo "$PROFILE_SNAP" | grep -qi "Current password" \
     && echo "$PROFILE_SNAP" | grep -qi "New password" \
     && echo "$PROFILE_SNAP" | grep -qi "Confirm new password"; then
    pass "9b. all three password fields present"
  else
    fail "9b. password form fields missing"
  fi

  # 9c. Mismatch validation: type two different new passwords, expect mismatch message.
  npx agent-browser fill 'input#current-password' "$NEW_PASSWORD" 2>/dev/null
  npx agent-browser fill 'input#new-password' "abc123-foo" 2>/dev/null
  npx agent-browser fill 'input#confirm-password' "different-confirm" 2>/dev/null
  sleep 1
  MISMATCH_SNAP=$(npx agent-browser snapshot 2>/dev/null)
  if echo "$MISMATCH_SNAP" | grep -qi "do not match"; then
    pass "9c. mismatch validation shows 'Passwords do not match'"
  else
    fail "9c. mismatch validation message missing"
  fi
  npx agent-browser close 2>/dev/null || true
else
  skip "9. agent-browser not available — UI flow skipped"
fi

# ── 10. CLEANUP — restore INITIAL_PASSWORD ────────────────────────
# CRITICAL: if this fails, every subsequent UAT plan that signs in with
# INITIAL_PASSWORD will lock out. We try the API path first, and fall
# back to the recover endpoint (plan 07) which resets to INITIAL_PASSWORD.

RESTORE_HTTP=$(curl -s -o /tmp/uat-28-restore.json -w "%{http_code}" \
  -b "$NEW_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"currentPassword\":\"$NEW_PASSWORD\",\"newPassword\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/change-password")

if [ "$RESTORE_HTTP" = "200" ]; then
  pass "10a. password restored to INITIAL_PASSWORD via change-password"
else
  fail "10a. change-password restore returned HTTP $RESTORE_HTTP — falling back to /auth/recover"
  if [ -n "${BETTER_AUTH_SECRET:-}" ]; then
    RECOVER_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST -H "Content-Type: application/json" \
      -d "{\"secretKey\":\"$BETTER_AUTH_SECRET\"}" \
      "$SERVER_URL/auth/recover")
    if [ "$RECOVER_HTTP" = "200" ]; then
      pass "10b. /auth/recover fallback restored INITIAL_PASSWORD"
    else
      fail "10b. /auth/recover fallback failed (HTTP $RECOVER_HTTP) — DB password is now '$NEW_PASSWORD' until manually reset"
    fi
  else
    fail "10b. BETTER_AUTH_SECRET unset — cannot use recover fallback. Manual DB reset required."
  fi
fi

# Verify INITIAL_PASSWORD signs in again so subsequent plans are unblocked.
FINAL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -c /tmp/uat-28-final.txt -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
rm -f /tmp/uat-28-final.txt
if [ "$FINAL_HTTP" = "200" ]; then
  pass "10c. INITIAL_PASSWORD signs in after restore — subsequent plans unblocked"
else
  fail "10c. INITIAL_PASSWORD STILL FAILS after restore (HTTP $FINAL_HTTP) — manual intervention required"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 1 | Baseline sign-in with `INITIAL_PASSWORD` succeeds; pre-rotation `accounts.password` hash captured | `core/src/auth.ts`, `db/schema.ts` |
| 2 | Wrong `currentPassword` rejected (400/401); `accounts.password` hash unchanged; `INITIAL_PASSWORD` still works | better-auth `change-password` plugin |
| 3 | Anonymous `change-password` returns 401 (no session, no mutation) | better-auth session middleware |
| 4 | Valid `change-password` returns 200; hash rotates; old password rejected; new password signs in into a fresh cookie jar; new session reaches `/users/profile` | PR #191 — `useChangePassword.ts` → `authClient.changePassword()` |
| 5 | Authed publish on a seeded wiki returns 200 with `publishedSlug` + `published=true`; `GET /wikis/<key>` reflects `published=true` and matching slug | `wikis.ts:469-501`, `wikiResponseSchema` (PR #191 added `published`/`publishedSlug`) |
| 6 | Anon `GET /published/wiki/<slug>` returns 200 with `name`, `content`, `publishedAt`, `refs`, `sections` | `core/src/routes/published.ts` + `publicWikiResponseSchema` |
| 7 | Anon `GET $WIKI_URL/p/<slug>` returns 200 HTML with wiki name, `og:title` + `og:type=article` meta, "Robin Wiki" branding, no authenticated chrome | `wiki/src/app/(public)/p/[nanoid]/page.tsx` + `PublishedWikiArticle.tsx` |
| 8 | Anon mutating call (unpublish) returns 401; after authed unpublish, anon JSON + page both 404; bogus slug also 404 | `wikis.ts:503-525` + `published.ts:29-31` |
| 9 | Profile UI renders Security → Change password section with three fields and mismatch validation message (skipped if agent-browser unavailable) | `wiki/src/app/profile/page.tsx` (PR #191) |
| 10 | Cleanup: `change-password` restores `INITIAL_PASSWORD`; `/auth/recover` fallback if step fails; final sign-in with `INITIAL_PASSWORD` confirms subsequent UAT plans are unblocked | better-auth + plan 07 fallback |

---

## Notes

- **Endpoint shape assumption.** PR #191 calls `authClient.changePassword({ currentPassword, newPassword })` from the client; better-auth's matching server endpoint is `POST /api/auth/change-password` with that exact body. If a future better-auth version renames the path, update steps 2/3/4/10. The negative test in step 2 explicitly accepts both 400 and 401 because better-auth has used both for the "wrong current password" branch in different versions — what matters is that it is NOT 200 and the hash does not move.
- **Session-invalidation drift.** Better-auth's `change-password` does NOT invalidate the existing session by default. The plan reflects this by asserting only that the *new password works for sign-in* and the *old password no longer works*, not that the old cookie jar 401s. If `revokeOtherSessions: true` is later wired in (it is not in PR #191), add an assertion that `OLD_JAR` returns 401 on `/users/profile`.
- **Hash inspection without printing the secret.** Step 1b/2b/4b use `md5(coalesce(a.password,''))` over `psql -t -A` and only compare hex digests — the actual bcrypt/scrypt hash is never printed. The query joins `accounts → users` because better-auth stores credentials on the `accounts` row keyed by user.
- **Public-page route authority.** PR #191 puts the page at `wiki/src/app/(public)/p/[nanoid]/page.tsx`. Step 7 hits `$WIKI_URL/p/<slug>`; if the harness runs the wiki app on a different port set `WIKI_URL` accordingly. The page issues a server-side fetch to `$NEXT_PUBLIC_ROBIN_API` — when the wiki container can't reach the core URL the page degrades to 404 even on a published wiki, which would fail step 7a (and is a real ops bug to surface).
- **OG metadata assertion.** `generateMetadata` in `page.tsx` emits `openGraph: { title, description, type: "article", publishedTime, siteName }`. Step 7c/7d look for `og:title` and `og:type=article`. Next.js renders these as `<meta property="og:title" ...>` in the SSR HTML — the assertion uses `property="..."` matching first, then falls back to `name="..."` for tooling that emits the older form.
- **Cleanup is mandatory.** Step 10 uses two paths: the API restore (preferred — exercises the feature symmetrically) and the `/auth/recover` fallback from plan 07. The final assertion 10c is the gate: if `INITIAL_PASSWORD` does not sign in at the end of this plan, every later plan that depends on baseline auth (03, 04, 05, 06, 09, 16, 21, 22, …) will fail. A failing 10c should halt the suite.
- **Storage is Postgres-only.** Password hashes live in `accounts.password` (bcrypt via better-auth). Published wiki rows live in `wikis` with `published`, `published_slug`, `published_at` columns. No filesystem state on either feature.

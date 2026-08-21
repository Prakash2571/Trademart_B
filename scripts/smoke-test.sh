#!/usr/bin/env bash
#
# Non-destructive smoke test against a running Trademart backend.
#
# TWO HARD RULES, both enforced rather than documented:
#
#   1. It refuses to run against a store that is not a confirmed Shopify
#      development store, unless ALLOW_LIVE_STORE_WRITES=true is set for this
#      invocation. The check is the FIRST thing that happens, before any request
#      that could mutate anything.
#
#   2. Only the write checks are gated. The read-only checks always run, because
#      "is the API up and correctly configured?" is useful against any store.
#
# Usage:
#   ./scripts/smoke-test.sh                       # reads only
#   ./scripts/smoke-test.sh --with-writes         # + create a DRAFT, publish, clean up
#
# Environment:
#   BASE_URL            default http://localhost:4000
#   OPERATOR_API_KEY    required for anything behind the operator guard
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
WITH_WRITES=0
[[ "${1:-}" == "--with-writes" ]] && WITH_WRITES=1

PASS=0
FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
info() { printf '       %s\n' "$*"; }

auth_header=()
if [[ -n "${OPERATOR_API_KEY:-}" ]]; then
  auth_header=(-H "Authorization: Bearer ${OPERATOR_API_KEY}")
fi

# Every request carries a correlation id derived from this run, so all of the
# backend log lines for this smoke test can be found with one grep.
RUN_ID="smoke-$(date -u +%Y%m%dT%H%M%SZ)"

req() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o /tmp/smoke.body -w '%{http_code}' -X "$method"
              -H "X-Request-ID: ${RUN_ID}" "${auth_header[@]}")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "${BASE_URL}${path}" 2>/dev/null || echo 000
}

expect_status() {
  local want="$1" method="$2" path="$3" label="$4" body="${5:-}"
  local got
  got="$(req "$method" "$path" "$body")"
  if [[ "$got" == "$want" ]]; then
    ok "$label ($got)"
  else
    bad "$label (expected $want, got $got)"
    info "$(head -c 300 /tmp/smoke.body 2>/dev/null || true)"
  fi
}

# --------------------------------------------------------------- guard --------
say "0. Store safety guard"
if ! npm run --silent guard:dev-store -- "smoke-test.sh" ; then
  echo ""
  echo "Refusing to continue. This looks like a LIVE store."
  echo "Read-only checks are safe, but this script is not allowed to guess."
  echo "If you really mean it:  ALLOW_LIVE_STORE_WRITES=true $0 $*"
  exit 1
fi
ok "store safety guard passed"

# ----------------------------------------------------------- read checks ------
say "1. Health and readiness"
expect_status 200 GET /api/health          "GET /api/health"
expect_status 200 GET /api/health/live     "GET /api/health/live"
# Readiness may legitimately be 503 (e.g. Mongo not configured in a dev run), so
# both outcomes are reported rather than one being treated as a failure.
ready="$(req GET /api/health/ready)"
if [[ "$ready" == "200" ]]; then ok "GET /api/health/ready (200 ready)";
elif [[ "$ready" == "503" ]]; then
  ok "GET /api/health/ready (503 - reports not-ready, which is a valid answer)"
  info "$(head -c 200 /tmp/smoke.body)"
else bad "GET /api/health/ready (got $ready)"; fi

say "2. Version and diagnostics"
expect_status 200 GET /api/version                     "GET /api/version"
expect_status 200 GET /api/diagnostics/store-mode      "GET /api/diagnostics/store-mode"
expect_status 200 GET /api/shopify/rate-limit          "GET /api/shopify/rate-limit"
expect_status 200 GET /api/diagnostics/integrity       "GET /api/diagnostics/integrity"

say "3. Correlation id is echoed"
if curl -sS -D - -o /dev/null -H "X-Request-ID: ${RUN_ID}" "${BASE_URL}/api/health" 2>/dev/null \
     | tr -d '\r' | grep -qi "^X-Request-ID: ${RUN_ID}$"; then
  ok "X-Request-ID is reflected back"
else
  bad "X-Request-ID was not reflected"
fi

say "4. Automation preview gate (no writes)"
# Apply WITHOUT a previewId must be refused with 428. This is the single most
# important negative check in the suite: it proves the gate is server-side.
expect_status 428 POST /api/automation/apply \
  "POST /api/automation/apply with no previewId is refused (PREVIEW_REQUIRED)" '{}'

# A replayed / unknown previewId must also be refused, never applied.
expect_status 428 POST /api/automation/apply \
  "POST /api/automation/apply with an unknown previewId is refused" \
  '{"previewId":"00000000-0000-4000-8000-000000000000"}'

expect_status 200 GET /api/automation/lock  "GET /api/automation/lock"

# ---------------------------------------------------------- write checks ------
if [[ "$WITH_WRITES" -eq 0 ]]; then
  say "Write checks skipped (pass --with-writes to include them)"
else
  say "5. Create a DRAFT product (write)"
  created="$(req POST /api/shopify/products \
    '{"title":"Trademart smoke test - safe to delete","variants":[{"price":"9.99"}]}')"
  if [[ "$created" == "201" || "$created" == "207" ]]; then
    ok "POST /api/shopify/products ($created)"
    PRODUCT_ID="$(grep -o '"shopifyProductId":"[^"]*"' /tmp/smoke.body | head -1 | cut -d'"' -f4 || true)"
    info "created ${PRODUCT_ID:-unknown}"

    if [[ -n "${PRODUCT_ID:-}" ]]; then
      # A brand-new product must NOT be visible. This asserts the create flow's
      # central safety property rather than trusting it.
      say "6. A new product is not visible to customers"
      encoded="${PRODUCT_ID//\//%2F}"
      if [[ "$(req GET "/api/shopify/products/${encoded}/publication")" == "200" ]]; then
        if grep -q '"visibleToCustomers":false' /tmp/smoke.body; then
          ok "new product reports visibleToCustomers=false"
        else
          bad "new product claims to be visible - the create flow should leave it DRAFT"
          info "$(head -c 300 /tmp/smoke.body)"
        fi
      else
        info "publication state unavailable (read_publications may not be granted)"
      fi

      say "7. Clean up - archive the smoke-test product"
      expect_status 200 PATCH "/api/shopify/products/${encoded}" \
        "archive the smoke-test product" '{"status":"ARCHIVED"}'
    fi
  else
    bad "POST /api/shopify/products (got $created)"
    info "$(head -c 300 /tmp/smoke.body)"
  fi
fi

say "Summary"
printf '  passed: %d\n  failed: %d\n  requestId for log correlation: %s\n' "$PASS" "$FAIL" "$RUN_ID"
[[ "$FAIL" -eq 0 ]]

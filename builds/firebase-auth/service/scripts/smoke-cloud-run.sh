#!/usr/bin/env bash
# =============================================================================
# Smoke Test — Cloud Run Service via gcloud Proxy (ADR-009)
# =============================================================================
#
# Connects to an internal-only Cloud Run service through gcloud run services
# proxy, then runs smoke tests by curling localhost. The proxy authenticates
# using the operator's gcloud credentials (no security window — service is
# never publicly accessible).
#
# Usage:
#   ./scripts/smoke-cloud-run.sh
#
# Required environment variables:
#   GCP_PROJECT_ID  — GCP project containing the Cloud Run service
#   GCP_REGION      — Region where the service is deployed
#
# Optional environment variables:
#   SERVICE_NAME            — Cloud Run service name (default: firebase-auth)
#   PROXY_PORT              — Local port for the proxy (default: 18090)
#   FIREBASE_TEST_ID_TOKEN  — Enables happy-path tests (valid token verify,
#                             batch verify, user lookup)
#
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"

SERVICE_NAME="${SERVICE_NAME:-firebase-auth}"
PROXY_PORT="${PROXY_PORT:-18090}"
BASE_URL="http://localhost:${PROXY_PORT}"
HEALTH_TIMEOUT=30
HEALTH_INTERVAL=2
PROXY_PID=""

PASS=0
FAIL=0
SKIP=0

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_pass()    { echo -e "  ${GREEN}PASS${NC}  $1"; ((PASS++)); }
log_fail()    { echo -e "  ${RED}FAIL${NC}  $1"; ((FAIL++)); }
log_skip()    { echo -e "  ${YELLOW}SKIP${NC}  $1"; ((SKIP++)); }
log_section() { echo -e "\n${BOLD}${BLUE}=== $1 ===${NC}"; }
log_info()    { echo -e "  ${BLUE}INFO${NC}  $1"; }

# ---------------------------------------------------------------------------
# Cleanup: kill proxy on exit
# ---------------------------------------------------------------------------

cleanup() {
  if [ -n "${PROXY_PID}" ] && kill -0 "${PROXY_PID}" 2>/dev/null; then
    log_info "Stopping gcloud proxy (PID ${PROXY_PID})"
    kill "${PROXY_PID}" 2>/dev/null || true
    wait "${PROXY_PID}" 2>/dev/null || true
  fi
  echo ""
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# HTTP helpers (no jq dependency — same pattern as smoke-test.sh)
# ---------------------------------------------------------------------------

http_get() {
  local url="$1"
  local tmpfile
  tmpfile=$(mktemp)
  HTTP_STATUS=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -H "Content-Type: application/json" "$url" 2>/dev/null) || HTTP_STATUS=000
  HTTP_BODY=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"
}

http_post() {
  local url="$1"
  local body="${2:-}"
  local tmpfile
  tmpfile=$(mktemp)
  if [ -n "$body" ]; then
    HTTP_STATUS=$(curl -s -o "$tmpfile" -w "%{http_code}" \
      -X POST -H "Content-Type: application/json" -d "$body" "$url" 2>/dev/null) || HTTP_STATUS=000
  else
    HTTP_STATUS=$(curl -s -o "$tmpfile" -w "%{http_code}" \
      -X POST -H "Content-Type: application/json" "$url" 2>/dev/null) || HTTP_STATUS=000
  fi
  HTTP_BODY=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"
}

json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | grep -oP "\"${field}\"\s*:\s*\K(\"[^\"]*\"|[0-9]+|true|false|null)" | head -1 | tr -d '"'
}

json_has_field() {
  local json="$1"
  local field="$2"
  echo "$json" | grep -q "\"${field}\""
}

# ---------------------------------------------------------------------------
# Phase 1: Start gcloud proxy (ADR-009)
# ---------------------------------------------------------------------------

log_section "Starting gcloud run services proxy"
log_info "Service: ${SERVICE_NAME}"
log_info "Project: ${GCP_PROJECT_ID}"
log_info "Region:  ${GCP_REGION}"
log_info "Port:    ${PROXY_PORT}"

gcloud run services proxy "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --port="${PROXY_PORT}" &
PROXY_PID=$!

# Wait for proxy to become ready
log_info "Waiting for proxy to be ready (timeout: ${HEALTH_TIMEOUT}s)..."
elapsed=0
proxy_ready=false
while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
    proxy_ready=true
    log_info "Proxy ready after ${elapsed}s"
    break
  fi
  # Check proxy process is still running
  if ! kill -0 "${PROXY_PID}" 2>/dev/null; then
    echo -e "  ${RED}FAIL${NC}  gcloud proxy exited unexpectedly"
    exit 1
  fi
  sleep "$HEALTH_INTERVAL"
  ((elapsed += HEALTH_INTERVAL))
done

if [ "$proxy_ready" = "false" ]; then
  echo -e "  ${RED}FAIL${NC}  Proxy did not become ready within ${HEALTH_TIMEOUT}s"
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 2: Health endpoint
# ---------------------------------------------------------------------------

log_section "Health Endpoint"

http_get "${BASE_URL}/health"
if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "GET /health returns 200"
else
  log_fail "GET /health returned ${HTTP_STATUS}, expected 200"
fi

if json_has_field "$HTTP_BODY" "status"; then
  log_pass "Health response contains 'status' field"
else
  log_fail "Health response missing 'status' field"
fi

if json_has_field "$HTTP_BODY" "firebase_initialized"; then
  log_pass "Health response contains 'firebase_initialized' field"
else
  log_fail "Health response missing 'firebase_initialized' field"
fi

FIREBASE_INIT=$(json_field "$HTTP_BODY" "firebase_initialized")
if [ "$FIREBASE_INIT" = "true" ]; then
  log_pass "firebase_initialized is true"
else
  log_fail "firebase_initialized is ${FIREBASE_INIT}, expected true"
fi

if json_has_field "$HTTP_BODY" "version"; then
  log_pass "Health response contains 'version' field"
else
  log_fail "Health response missing 'version' field"
fi

if json_has_field "$HTTP_BODY" "timestamp"; then
  log_pass "Health response contains 'timestamp' field"
else
  log_fail "Health response missing 'timestamp' field"
fi

# ---------------------------------------------------------------------------
# Phase 3: Verify route — error paths
# ---------------------------------------------------------------------------

log_section "Verify Route — Error Paths"

# Missing body → 400
http_post "${BASE_URL}/verify" ""
if [ "$HTTP_STATUS" = "400" ]; then
  log_pass "POST /verify with missing body returns 400"
else
  log_fail "POST /verify with missing body returned ${HTTP_STATUS}, expected 400"
fi

# Non-JWT token → 400
http_post "${BASE_URL}/verify" '{"token":"not-a-jwt"}'
if [ "$HTTP_STATUS" = "400" ]; then
  log_pass "POST /verify with non-JWT token returns 400"
else
  log_fail "POST /verify with non-JWT token returned ${HTTP_STATUS}, expected 400"
fi

# Garbage JWT → 401 (valid structure, invalid signature)
GARBAGE_JWT="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0MTIzIiwiYXVkIjoiZmFrZSIsImlzcyI6Imh0dHBzOi8vc2VjdXJldG9rZW4uZ29vZ2xlLmNvbS9mYWtlIiwiZXhwIjo5OTk5OTk5OTk5LCJpYXQiOjE3MDAwMDAwMDB9.invalidsignaturedata"
http_post "${BASE_URL}/verify" "{\"token\":\"${GARBAGE_JWT}\"}"
if [ "$HTTP_STATUS" = "401" ]; then
  log_pass "POST /verify with garbage JWT returns 401"
else
  log_fail "POST /verify with garbage JWT returned ${HTTP_STATUS}, expected 401"
fi

# Verify 401 response is generic (no failure detail leaked)
if json_has_field "$HTTP_BODY" "error"; then
  # Check that error message is generic
  ERROR_MSG=$(json_field "$HTTP_BODY" "error")
  if echo "$ERROR_MSG" | grep -qi "expired\|signature\|revoked\|audience"; then
    log_fail "401 response leaks failure detail: ${ERROR_MSG}"
  else
    log_pass "401 response is generic (no failure detail leaked)"
  fi
else
  log_pass "401 response contains no error detail"
fi

# ---------------------------------------------------------------------------
# Phase 4: Batch verify — error paths
# ---------------------------------------------------------------------------

log_section "Batch Verify Route — Error Paths"

# Empty tokens array → 400
http_post "${BASE_URL}/batch-verify" '{"tokens":[]}'
if [ "$HTTP_STATUS" = "400" ]; then
  log_pass "POST /batch-verify with empty tokens array returns 400"
else
  log_fail "POST /batch-verify with empty tokens array returned ${HTTP_STATUS}, expected 400"
fi

# Missing body → 400
http_post "${BASE_URL}/batch-verify" ""
if [ "$HTTP_STATUS" = "400" ]; then
  log_pass "POST /batch-verify with missing body returns 400"
else
  log_fail "POST /batch-verify with missing body returned ${HTTP_STATUS}, expected 400"
fi

# ---------------------------------------------------------------------------
# Phase 5: Response headers
# ---------------------------------------------------------------------------

log_section "Response Headers"

HEADER_CHECK=$(curl -s -D - -o /dev/null "${BASE_URL}/health" 2>/dev/null)
if echo "$HEADER_CHECK" | grep -qi "x-request-id"; then
  log_pass "Response includes X-Request-ID header"
else
  log_skip "X-Request-ID header not found"
fi

# ---------------------------------------------------------------------------
# Phase 6: Happy-path tests (require FIREBASE_TEST_ID_TOKEN)
# ---------------------------------------------------------------------------

if [ -z "${FIREBASE_TEST_ID_TOKEN:-}" ]; then
  log_section "Happy-Path Tests (SKIPPED)"
  log_skip "FIREBASE_TEST_ID_TOKEN not set — skipping valid token tests"
  log_skip "POST /verify with valid token"
  log_skip "POST /batch-verify with mixed tokens"
  log_skip "GET /user-lookup with verified UID"
else
  log_section "Happy-Path Tests (Valid Token)"

  # Verify valid token
  http_post "${BASE_URL}/verify" "{\"token\":\"${FIREBASE_TEST_ID_TOKEN}\"}"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "POST /verify with valid token returns 200"

    VERIFIED_UID=$(json_field "$HTTP_BODY" "uid")
    if [ -n "$VERIFIED_UID" ]; then
      log_pass "Verify response contains uid: ${VERIFIED_UID}"
    else
      log_fail "Verify response missing uid field"
    fi

    if json_has_field "$HTTP_BODY" "email"; then
      log_pass "Verify response contains email field"
    else
      log_fail "Verify response missing email field"
    fi

    if json_has_field "$HTTP_BODY" "token_metadata"; then
      log_pass "Verify response contains token_metadata field"
    else
      log_fail "Verify response missing token_metadata field"
    fi
  else
    log_fail "POST /verify with valid token returned ${HTTP_STATUS}, expected 200"
    log_info "This may indicate an expired test token"
    log_info "Response: ${HTTP_BODY}"
    VERIFIED_UID=""
  fi

  # Batch verify with mix of valid and invalid tokens
  BATCH_BODY="{\"tokens\":[\"${FIREBASE_TEST_ID_TOKEN}\",\"${GARBAGE_JWT}\"]}"
  http_post "${BASE_URL}/batch-verify" "$BATCH_BODY"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "POST /batch-verify with mixed tokens returns 200"

    BATCH_TOTAL=$(json_field "$HTTP_BODY" "total")
    if [ "$BATCH_TOTAL" = "2" ]; then
      log_pass "Batch summary total is 2"
    else
      log_fail "Batch summary total is ${BATCH_TOTAL}, expected 2"
    fi
  else
    log_fail "POST /batch-verify with mixed tokens returned ${HTTP_STATUS}, expected 200"
    log_info "Response: ${HTTP_BODY}"
  fi

  # User lookup with UID from verified token
  if [ -n "${VERIFIED_UID:-}" ]; then
    http_get "${BASE_URL}/user-lookup/${VERIFIED_UID}"
    if [ "$HTTP_STATUS" = "200" ]; then
      log_pass "GET /user-lookup/${VERIFIED_UID} returns 200"

      if json_has_field "$HTTP_BODY" "uid"; then
        log_pass "User lookup response contains uid field"
      else
        log_fail "User lookup response missing uid field"
      fi

      if json_has_field "$HTTP_BODY" "disabled"; then
        log_pass "User lookup response contains disabled field"
      else
        log_fail "User lookup response missing disabled field"
      fi
    else
      log_fail "GET /user-lookup/${VERIFIED_UID} returned ${HTTP_STATUS}, expected 200"
      log_info "Response: ${HTTP_BODY}"
    fi
  else
    log_skip "Skipping user-lookup — no UID from verify response"
  fi
fi

# ---------------------------------------------------------------------------
# Results Summary
# ---------------------------------------------------------------------------

echo ""
log_section "Results"
echo -e "  ${GREEN}Passed:  ${PASS}${NC}"
echo -e "  ${RED}Failed:  ${FAIL}${NC}"
echo -e "  ${YELLOW}Skipped: ${SKIP}${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}${BOLD}CLOUD RUN SMOKE TEST FAILED${NC}"
  exit 1
fi

echo -e "${GREEN}${BOLD}CLOUD RUN SMOKE TEST PASSED${NC}"
exit 0

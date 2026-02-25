#!/usr/bin/env bash
# =============================================================================
# Emulator Smoke Test — Firebase Auth Service
# =============================================================================
#
# E2E test using the Firebase Auth Emulator. No credentials required.
# Starts emulator + app via docker compose, creates a test user via the
# emulator REST API, then tests all 4 endpoints with real tokens.
#
# Usage:
#   bash scripts/smoke-test.sh
#
# Requirements: curl, jq, docker compose
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${TEMPLATE_DIR}/docker-compose.yaml"

APP_URL="http://localhost:8080"
EMULATOR_URL="http://localhost:9099"
HEALTH_TIMEOUT=120
HEALTH_INTERVAL=2

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_pass()    { echo -e "  ${GREEN}PASS${NC}  $1"; PASS=$((PASS + 1)); }
log_fail()    { echo -e "  ${RED}FAIL${NC}  $1"; FAIL=$((FAIL + 1)); }
log_section() { echo -e "\n${BOLD}${BLUE}=== $1 ===${NC}"; }
log_info()    { echo -e "  ${BLUE}INFO${NC}  $1"; }

cleanup() {
  log_section "Cleanup"
  cd "$TEMPLATE_DIR"
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  log_info "Docker compose torn down"
}
trap cleanup EXIT

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
  HTTP_STATUS=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" -d "$body" "$url" 2>/dev/null) || HTTP_STATUS=000
  HTTP_BODY=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

for cmd in curl jq docker; do
  if ! command -v "$cmd" &>/dev/null; then
    echo -e "${RED}ERROR: ${cmd} is required but not found${NC}"
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Start services
# ---------------------------------------------------------------------------

log_section "Starting Services"
cd "$TEMPLATE_DIR"
docker compose -f "$COMPOSE_FILE" up -d --build 2>&1

# Wait for app health
log_info "Waiting for app to become healthy (timeout: ${HEALTH_TIMEOUT}s)..."
elapsed=0
while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf "${APP_URL}/health" >/dev/null 2>&1; then
    log_info "App healthy after ${elapsed}s"
    break
  fi
  sleep "$HEALTH_INTERVAL"
  ((elapsed += HEALTH_INTERVAL))
done

if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
  echo -e "${RED}${BOLD}ABORT: App did not become healthy within ${HEALTH_TIMEOUT}s${NC}"
  docker compose -f "$COMPOSE_FILE" logs 2>&1 | tail -40
  exit 1
fi

# ---------------------------------------------------------------------------
# Create test user via emulator REST API
# ---------------------------------------------------------------------------

log_section "Create Test User"

SIGNUP_BODY='{"email":"smoke@test.local","password":"TestPass1234","returnSecureToken":true}'
http_post "${EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key" "$SIGNUP_BODY"

if [ "$HTTP_STATUS" != "200" ]; then
  echo -e "${RED}ABORT: Failed to create test user (status: ${HTTP_STATUS})${NC}"
  echo "$HTTP_BODY"
  exit 1
fi

ID_TOKEN=$(echo "$HTTP_BODY" | jq -r '.idToken')
LOCAL_ID=$(echo "$HTTP_BODY" | jq -r '.localId')

if [ -z "$ID_TOKEN" ] || [ "$ID_TOKEN" = "null" ]; then
  echo -e "${RED}ABORT: No idToken in signup response${NC}"
  echo "$HTTP_BODY"
  exit 1
fi

log_info "Test user created: uid=${LOCAL_ID}"

# ---------------------------------------------------------------------------
# Test 1: GET /health
# ---------------------------------------------------------------------------

log_section "GET /health"

http_get "${APP_URL}/health"

if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "GET /health returns 200"
else
  log_fail "GET /health returned ${HTTP_STATUS}, expected 200"
fi

FIREBASE_INIT=$(echo "$HTTP_BODY" | jq -r '.firebase_initialized')
if [ "$FIREBASE_INIT" = "true" ]; then
  log_pass "firebase_initialized is true"
else
  log_fail "firebase_initialized is ${FIREBASE_INIT}, expected true"
fi

HEALTH_STATUS=$(echo "$HTTP_BODY" | jq -r '.status')
if [ "$HEALTH_STATUS" = "healthy" ]; then
  log_pass "status is healthy"
else
  log_fail "status is ${HEALTH_STATUS}, expected healthy"
fi

# ---------------------------------------------------------------------------
# Test 2: POST /verify
# ---------------------------------------------------------------------------

log_section "POST /verify"

http_post "${APP_URL}/verify" "{\"token\":\"${ID_TOKEN}\"}"

if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "POST /verify returns 200"
else
  log_fail "POST /verify returned ${HTTP_STATUS}, expected 200"
  log_info "Response: ${HTTP_BODY}"
fi

VERIFY_UID=$(echo "$HTTP_BODY" | jq -r '.uid')
if [ "$VERIFY_UID" = "$LOCAL_ID" ]; then
  log_pass "uid matches localId (${LOCAL_ID})"
else
  log_fail "uid is ${VERIFY_UID}, expected ${LOCAL_ID}"
fi

VERIFY_EMAIL=$(echo "$HTTP_BODY" | jq -r '.email')
if [ "$VERIFY_EMAIL" = "smoke@test.local" ]; then
  log_pass "email is smoke@test.local"
else
  log_fail "email is ${VERIFY_EMAIL}, expected smoke@test.local"
fi

# ---------------------------------------------------------------------------
# Test 3: GET /user-lookup/:uid
# ---------------------------------------------------------------------------

log_section "GET /user-lookup/${LOCAL_ID}"

http_get "${APP_URL}/user-lookup/${LOCAL_ID}"

if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "GET /user-lookup returns 200"
else
  log_fail "GET /user-lookup returned ${HTTP_STATUS}, expected 200"
  log_info "Response: ${HTTP_BODY}"
fi

LOOKUP_UID=$(echo "$HTTP_BODY" | jq -r '.uid')
if [ "$LOOKUP_UID" = "$LOCAL_ID" ]; then
  log_pass "uid matches"
else
  log_fail "uid is ${LOOKUP_UID}, expected ${LOCAL_ID}"
fi

LOOKUP_EMAIL=$(echo "$HTTP_BODY" | jq -r '.email')
if [ "$LOOKUP_EMAIL" = "smoke@test.local" ]; then
  log_pass "email matches"
else
  log_fail "email is ${LOOKUP_EMAIL}, expected smoke@test.local"
fi

# ---------------------------------------------------------------------------
# Test 4: POST /batch-verify
# ---------------------------------------------------------------------------

log_section "POST /batch-verify"

http_post "${APP_URL}/batch-verify" "{\"tokens\":[\"${ID_TOKEN}\"]}"

if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "POST /batch-verify returns 200"
else
  log_fail "POST /batch-verify returned ${HTTP_STATUS}, expected 200"
  log_info "Response: ${HTTP_BODY}"
fi

BATCH_VALID=$(echo "$HTTP_BODY" | jq -r '.summary.valid')
if [ "$BATCH_VALID" = "1" ]; then
  log_pass "summary.valid is 1"
else
  log_fail "summary.valid is ${BATCH_VALID}, expected 1"
fi

BATCH_TOTAL=$(echo "$HTTP_BODY" | jq -r '.summary.total')
if [ "$BATCH_TOTAL" = "1" ]; then
  log_pass "summary.total is 1"
else
  log_fail "summary.total is ${BATCH_TOTAL}, expected 1"
fi

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

echo ""
log_section "Results"
echo -e "  ${GREEN}Passed:  ${PASS}${NC}"
echo -e "  ${RED}Failed:  ${FAIL}${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}${BOLD}SMOKE TEST FAILED${NC}"
  exit 1
fi

echo -e "${GREEN}${BOLD}SMOKE TEST PASSED${NC}"
exit 0

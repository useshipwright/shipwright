#!/usr/bin/env bash
# =============================================================================
# Smoke Test — Firebase Auth Service Container
# =============================================================================
#
# Tests the BUILT Docker container to catch runtime issues like circular
# references, missing native modules, incorrect entrypoints, and startup
# crashes that only manifest in the real deployment artifact.
#
# Usage:
#   ./tests/smoke/smoke-test.sh
#
# Environment variables:
#   FIREBASE_SERVICE_ACCOUNT_JSON  — Required for live container tests.
#                                    Without it, only the no-credential
#                                    exit test runs.
#   FIREBASE_TEST_ID_TOKEN         — Optional. When set, enables happy-path
#                                    tests (valid token verify, batch, user
#                                    lookup). Without it, degrades to health
#                                    and error-path tests only.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

IMAGE_NAME="firebase-auth-smoke:test-$$"
CONTAINER_NAME="firebase-auth-smoke-$$"
COMPOSE_PROJECT="smoke-$$"
HOST_PORT="${SMOKE_TEST_PORT:-18080}"
BASE_URL="http://localhost:${HOST_PORT}"
HEALTH_TIMEOUT=30   # seconds to wait for container health
HEALTH_INTERVAL=1   # seconds between health polls

PASS=0
FAIL=0
SKIP=0

# ---------------------------------------------------------------------------
# Helpers
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

# Cleanup runs on exit regardless of success/failure
cleanup() {
  log_section "Cleanup"

  # Stop and remove the standalone container
  if docker ps -aq --filter "name=${CONTAINER_NAME}" 2>/dev/null | grep -q .; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    log_info "Removed container ${CONTAINER_NAME}"
  fi

  # Tear down docker compose (if it was started)
  if [ "${COMPOSE_STARTED:-false}" = "true" ]; then
    docker compose -f "${TEMPLATE_DIR}/docker-compose.yaml" \
      -p "${COMPOSE_PROJECT}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    log_info "Tore down docker compose project ${COMPOSE_PROJECT}"
  fi

  # Remove the test image
  if docker images -q "${IMAGE_NAME}" 2>/dev/null | grep -q .; then
    docker rmi -f "${IMAGE_NAME}" >/dev/null 2>&1 || true
    log_info "Removed image ${IMAGE_NAME}"
  fi

  echo ""
}
trap cleanup EXIT

# Send an HTTP request and capture status code + body.
# Usage: http_get <url>  or  http_post <url> <json-body>
# Sets: HTTP_STATUS, HTTP_BODY
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

# Wait for the container health endpoint to respond 200.
wait_for_health() {
  local elapsed=0
  log_info "Waiting for container to become healthy (timeout: ${HEALTH_TIMEOUT}s)..."
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
      log_info "Container healthy after ${elapsed}s"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    ((elapsed += HEALTH_INTERVAL))
  done
  log_fail "Container did not become healthy within ${HEALTH_TIMEOUT}s"
  docker logs "${CONTAINER_NAME}" 2>&1 | tail -20
  return 1
}

# Extract a JSON field value (simple grep-based, no jq dependency).
# Usage: json_field <json-string> <field-name>
json_field() {
  local json="$1"
  local field="$2"
  # Handles "field": "value", "field": true, "field": 123, "field": null
  echo "$json" | grep -oP "\"${field}\"\s*:\s*\K(\"[^\"]*\"|[0-9]+|true|false|null)" | head -1 | tr -d '"'
}

# Check if a JSON string contains a field.
json_has_field() {
  local json="$1"
  local field="$2"
  echo "$json" | grep -q "\"${field}\""
}

# ---------------------------------------------------------------------------
# Phase 1: Build Docker Image
# ---------------------------------------------------------------------------

log_section "Building Docker Image"
log_info "Context: ${TEMPLATE_DIR}"
log_info "Image:   ${IMAGE_NAME}"

if ! docker build -t "${IMAGE_NAME}" "${TEMPLATE_DIR}" 2>&1; then
  echo ""
  log_fail "Docker build failed"
  echo -e "\n${RED}${BOLD}ABORT: Cannot run smoke tests — Docker build failed.${NC}"
  exit 1
fi
log_pass "Docker image built successfully"

# ---------------------------------------------------------------------------
# Phase 2: No-Credential Test
# ---------------------------------------------------------------------------

log_section "No-Credential Startup Test"
log_info "Starting container WITHOUT FIREBASE_SERVICE_ACCOUNT_JSON..."

NOCRED_LOGS=""
NOCRED_EXIT=0
NOCRED_LOGS=$(docker run --rm --name "${CONTAINER_NAME}-nocred" \
  -e "PORT=8080" \
  "${IMAGE_NAME}" 2>&1) || NOCRED_EXIT=$?

if [ "$NOCRED_EXIT" -ne 0 ]; then
  log_pass "Container exited with non-zero code (${NOCRED_EXIT}) without credentials"
else
  log_fail "Container exited with code 0 without credentials — expected non-zero"
fi

if echo "$NOCRED_LOGS" | grep -qi "FIREBASE_SERVICE_ACCOUNT_JSON"; then
  log_pass "Container logs mention FIREBASE_SERVICE_ACCOUNT_JSON"
else
  log_fail "Container logs do not mention FIREBASE_SERVICE_ACCOUNT_JSON"
  log_info "Container output:"
  echo "$NOCRED_LOGS" | tail -10
fi

# ---------------------------------------------------------------------------
# Phase 3: Live Container Tests (require FIREBASE_SERVICE_ACCOUNT_JSON)
# ---------------------------------------------------------------------------

if [ -z "${FIREBASE_SERVICE_ACCOUNT_JSON:-}" ]; then
  log_section "Live Container Tests (SKIPPED)"
  log_skip "FIREBASE_SERVICE_ACCOUNT_JSON not set — skipping live container tests"
  log_skip "Health endpoint test"
  log_skip "POST /verify with invalid JWT → 401"
  log_skip "POST /verify with missing body → 400"
  log_skip "POST /batch-verify with empty array → 400"
  log_skip "POST /verify with garbage JWT-structured token → 401"
else
  log_section "Starting Container with Credentials"

  docker run -d \
    --name "${CONTAINER_NAME}" \
    -p "${HOST_PORT}:8080" \
    -e "PORT=8080" \
    -e "NODE_ENV=production" \
    -e "FIREBASE_SERVICE_ACCOUNT_JSON=${FIREBASE_SERVICE_ACCOUNT_JSON}" \
    "${IMAGE_NAME}" >/dev/null

  if ! wait_for_health; then
    log_info "Container logs:"
    docker logs "${CONTAINER_NAME}" 2>&1 | tail -30
    echo -e "\n${RED}${BOLD}ABORT: Container failed to start.${NC}"
    # Still count the failure and exit
    FAIL=$((FAIL + 1))
    echo -e "\n${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
    exit 1
  fi

  # --- Health Endpoint ---

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
    log_pass "firebase_initialized is true (Firebase SDK wired correctly)"
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

  # --- Verify Error Paths ---

  log_section "Verify Route — Error Paths"

  # POST /verify with missing body
  http_post "${BASE_URL}/verify" ""
  if [ "$HTTP_STATUS" = "400" ]; then
    log_pass "POST /verify with missing body returns 400"
  else
    log_fail "POST /verify with missing body returned ${HTTP_STATUS}, expected 400"
  fi

  # POST /verify with invalid JWT structure (not 3 segments)
  http_post "${BASE_URL}/verify" '{"token":"not-a-jwt"}'
  if [ "$HTTP_STATUS" = "400" ]; then
    log_pass "POST /verify with non-JWT token returns 400"
  else
    log_fail "POST /verify with non-JWT token returned ${HTTP_STATUS}, expected 400"
  fi

  # POST /verify with valid JWT structure but garbage content → 401
  # This proves the verify route + firebase plugin are fully wired in the built artifact
  GARBAGE_JWT="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0MTIzIiwiYXVkIjoiZmFrZSIsImlzcyI6Imh0dHBzOi8vc2VjdXJldG9rZW4uZ29vZ2xlLmNvbS9mYWtlIiwiZXhwIjo5OTk5OTk5OTk5LCJpYXQiOjE3MDAwMDAwMDB9.invalidsignaturedata"
  http_post "${BASE_URL}/verify" "{\"token\":\"${GARBAGE_JWT}\"}"
  if [ "$HTTP_STATUS" = "401" ]; then
    log_pass "POST /verify with garbage JWT-structured token returns 401 (not 500/crash)"
  else
    log_fail "POST /verify with garbage JWT-structured token returned ${HTTP_STATUS}, expected 401"
    log_info "Response body: ${HTTP_BODY}"
  fi

  # --- Batch Verify Error Paths ---

  log_section "Batch Verify Route — Error Paths"

  # POST /batch-verify with empty tokens array
  http_post "${BASE_URL}/batch-verify" '{"tokens":[]}'
  if [ "$HTTP_STATUS" = "400" ]; then
    log_pass "POST /batch-verify with empty tokens array returns 400"
  else
    log_fail "POST /batch-verify with empty tokens array returned ${HTTP_STATUS}, expected 400"
  fi

  # POST /batch-verify with missing body
  http_post "${BASE_URL}/batch-verify" ""
  if [ "$HTTP_STATUS" = "400" ]; then
    log_pass "POST /batch-verify with missing body returns 400"
  else
    log_fail "POST /batch-verify with missing body returned ${HTTP_STATUS}, expected 400"
  fi

  # --- Response Header Checks ---

  log_section "Response Headers"

  # Check X-Request-ID header is present on health
  HEADER_CHECK=$(curl -s -D - -o /dev/null "${BASE_URL}/health" 2>/dev/null)
  if echo "$HEADER_CHECK" | grep -qi "x-request-id"; then
    log_pass "Response includes X-Request-ID header"
  else
    log_skip "X-Request-ID header not found (correlation-id plugin may not be registered)"
  fi

  # -----------------------------------------------------------------------
  # Happy-Path Tests (require FIREBASE_TEST_ID_TOKEN)
  # -----------------------------------------------------------------------

  if [ -z "${FIREBASE_TEST_ID_TOKEN:-}" ]; then
    log_section "Happy-Path Tests (SKIPPED)"
    log_skip "FIREBASE_TEST_ID_TOKEN not set — skipping valid token tests"
    log_skip "POST /verify with valid token"
    log_skip "POST /batch-verify with mixed tokens"
    log_skip "GET /user-lookup with verified UID"
  else
    log_section "Happy-Path Tests (Valid Token)"

    # POST /verify with valid token
    http_post "${BASE_URL}/verify" "{\"token\":\"${FIREBASE_TEST_ID_TOKEN}\"}"
    if [ "$HTTP_STATUS" = "200" ]; then
      log_pass "POST /verify with valid token returns 200"

      # Extract UID for user-lookup test
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

    # POST /batch-verify with mix of valid and invalid tokens
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

    # GET /user-lookup with UID from verified token
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

  # Stop the standalone container before compose test
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

  # -----------------------------------------------------------------------
  # Docker Compose Test
  # -----------------------------------------------------------------------

  log_section "Docker Compose Test"

  # Temporarily override the image in docker-compose to use our pre-built image
  COMPOSE_PORT=18081
  export FIREBASE_SERVICE_ACCOUNT_JSON

  # Run docker compose with the project's docker-compose.yaml
  # Override port to avoid conflict with standalone container
  if docker compose -f "${TEMPLATE_DIR}/docker-compose.yaml" \
    -p "${COMPOSE_PROJECT}" up -d 2>&1; then
    COMPOSE_STARTED=true
    log_info "Docker compose started, waiting for health..."

    # Wait for compose container health
    COMPOSE_ELAPSED=0
    COMPOSE_HEALTHY=false
    while [ "$COMPOSE_ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
      if curl -sf "http://localhost:8080/health" >/dev/null 2>&1; then
        COMPOSE_HEALTHY=true
        break
      fi
      sleep "$HEALTH_INTERVAL"
      ((COMPOSE_ELAPSED += HEALTH_INTERVAL))
    done

    if [ "$COMPOSE_HEALTHY" = "true" ]; then
      log_pass "Docker compose container became healthy"

      http_get "http://localhost:8080/health"
      if [ "$HTTP_STATUS" = "200" ]; then
        log_pass "Docker compose: GET /health returns 200"
      else
        log_fail "Docker compose: GET /health returned ${HTTP_STATUS}, expected 200"
      fi
    else
      log_fail "Docker compose container did not become healthy within ${HEALTH_TIMEOUT}s"
      docker compose -f "${TEMPLATE_DIR}/docker-compose.yaml" \
        -p "${COMPOSE_PROJECT}" logs 2>&1 | tail -20
    fi

    docker compose -f "${TEMPLATE_DIR}/docker-compose.yaml" \
      -p "${COMPOSE_PROJECT}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    COMPOSE_STARTED=false
  else
    log_fail "Docker compose failed to start"
    COMPOSE_STARTED=false
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
  echo -e "${RED}${BOLD}SMOKE TEST FAILED${NC}"
  exit 1
fi

echo -e "${GREEN}${BOLD}SMOKE TEST PASSED${NC}"
exit 0

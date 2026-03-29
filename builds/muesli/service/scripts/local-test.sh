#!/usr/bin/env bash
# Local smoke test for Muesli -- starts Firestore emulator, boots the app, hits endpoints.
# Usage: bash scripts/local-test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
PORT=8080
EMU_PORT=8681
EMU_NAME="muesli-firestore-emu"

cleanup() {
  echo "[cleanup] Stopping..."
  kill "$APP_PID" 2>/dev/null || true
  docker rm -f "$EMU_NAME" 2>/dev/null || true
}
trap cleanup EXIT

cd "$APP_DIR"

# 1. Start Firestore emulator
echo "[1/4] Starting Firestore emulator..."
docker rm -f "$EMU_NAME" 2>/dev/null || true
docker run -d --name "$EMU_NAME" -p "$EMU_PORT:$EMU_PORT" \
  google/cloud-sdk:emulators \
  gcloud emulators firestore start --host-port="0.0.0.0:$EMU_PORT" >/dev/null 2>&1

# Wait for emulator
for i in $(seq 1 15); do
  if curl -s "http://localhost:$EMU_PORT" >/dev/null 2>&1; then
    echo "  Firestore emulator ready"
    break
  fi
  sleep 1
done

# 2. Build TypeScript
echo "[2/4] Compiling TypeScript..."
npx tsc --noEmit

# 3. Start the app
echo "[3/4] Starting Muesli on :$PORT..."
FIRESTORE_EMULATOR_HOST="localhost:$EMU_PORT" \
GOOGLE_CLOUD_PROJECT="muesli-test" \
GCS_BUCKET="muesli-test" \
ANTHROPIC_API_KEY="sk-test-not-real" \
DEEPGRAM_API_KEY="test-not-real" \
PORT="$PORT" \
NODE_ENV="development" \
LOG_LEVEL="warn" \
npx tsx src/server.ts &
APP_PID=$!

# Wait for app
for i in $(seq 1 15); do
  if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo "  App ready on :$PORT"
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "  FAIL: App crashed during startup"
    wait "$APP_PID" || true
    exit 1
  fi
  sleep 1
done

# 4. Hit endpoints
echo "[4/4] Testing endpoints..."
echo ""

pass=0
fail=0

check() {
  local method="$1" url="$2" expect="$3" label="$4"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "http://localhost:$PORT$url")
  if [ "$status" = "$expect" ]; then
    echo "  PASS  $method $url -> $status"
    pass=$((pass + 1))
  else
    echo "  FAIL  $method $url -> $status (expected $expect)"
    fail=$((fail + 1))
  fi
}

# Health (no auth)
check GET "/health" "200" "Health liveness"
check GET "/health/ready" "200" "Health readiness"

# API routes (should return 401 without auth token)
check GET "/api/meetings" "401" "Meetings list (no auth)"
check POST "/api/meetings" "401" "Create meeting (no auth)"
check GET "/api/templates" "401" "Templates list (no auth)"
check GET "/api/actions" "401" "Actions list (no auth)"
check GET "/api/search?q=test" "401" "Search (no auth)"
check POST "/api/ai/ask" "401" "AI Q&A (no auth)"
check GET "/api/me" "401" "User profile (no auth)"
check GET "/api/calendar/events" "401" "Calendar events (no auth)"

# Share endpoint (public shares don't need auth, but nonexistent = 404)
check GET "/api/share/nonexistent" "404" "Share lookup (not found)"

# Internal routes (should return 401/403 without OIDC)
check POST "/internal/process-audio" "401" "Internal audio (no OIDC)"
check POST "/internal/calendar-sync" "401" "Internal calendar (no OIDC)"

echo ""
echo "Results: $pass passed, $fail failed ($(( pass + fail )) total)"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
echo "All checks passed."

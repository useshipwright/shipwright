#!/usr/bin/env bash
# smoke-test.sh -- Build, run, and test the Firebase Auth service locally
#
# Usage: bash scripts/smoke-test.sh
#
# Builds Docker image, starts container, tests all endpoints, cleans up.
# No real Firebase credentials needed -- uses test config.

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

CONTAINER="firebase-auth-smoke-$$"
IMAGE="firebase-auth:smoke"
PORT=$((49152 + RANDOM % 16384))
API_KEY="smoke-test-key-001"
BASE="http://localhost:$PORT"
PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL+1)); }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo ""
echo -e "${BOLD}=== Firebase Auth Smoke Test ===${NC}"
echo ""

# -- Build --
echo "[1/4] Building Docker image..."
if docker build -t "$IMAGE" . >/dev/null 2>&1; then
    pass "Docker build"
else
    fail "Docker build -- run 'docker build .' to see errors"
    exit 1
fi

# -- Start --
echo "[2/4] Starting container on port $PORT..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

SA_JSON='{"type":"service_account","project_id":"smoke-test","private_key_id":"k","private_key":"-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n","client_email":"t@t.iam.gserviceaccount.com","client_id":"1","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token"}'

CID=$(docker run -d --name "$CONTAINER" -p "$PORT:8080" \
    -e "FIREBASE_SERVICE_ACCOUNT_JSON=$SA_JSON" \
    -e "API_KEYS=$API_KEY" \
    -e LOG_LEVEL=warn \
    -e SKIP_FIREBASE_HEALTH_PROBE=true \
    "$IMAGE" 2>&1) || true

if [ -z "$CID" ]; then
    fail "Container failed to start"
    exit 1
fi

# Wait for HTTP
STARTED=false
for _ in $(seq 1 30); do
    if curl -s -o /dev/null -w '' "$BASE/health" 2>/dev/null; then
        STARTED=true
        break
    fi
    # Check container didn't crash
    if ! docker ps -q --filter "name=$CONTAINER" | grep -q .; then
        fail "Container exited"
        echo "  Logs:"
        docker logs "$CONTAINER" 2>&1 | tail -10 | sed 's/^/    /'
        exit 1
    fi
    sleep 1
done

if $STARTED; then
    pass "Container started (port $PORT)"
else
    fail "Container not responding after 30s"
    docker logs "$CONTAINER" 2>&1 | tail -10 | sed 's/^/    /'
    exit 1
fi

# -- Test endpoints --
echo "[3/4] Testing endpoints..."

test_ep() {
    local method="$1" path="$2" expect="$3" label="$4"
    local body="${5:-}" auth="${6:-yes}"

    local args=(-s -o /dev/null -w "%{http_code}" -X "$method")
    [ "$auth" = "yes" ] && args+=(-H "X-API-Key: $API_KEY")
    args+=(-H "Content-Type: application/json")
    [ -n "$body" ] && args+=(-d "$body")
    args+=("$BASE$path")

    local got
    got=$(curl "${args[@]}" 2>/dev/null) || got="000"

    if [ "$got" = "$expect" ]; then
        pass "$label ($got)"
    else
        fail "$label (got $got, expected $expect)"
    fi
}

# Public
test_ep GET /health 200 "Health check" "" no
test_ep GET /metrics 200 "Prometheus metrics" "" no

# Auth required
test_ep POST /verify 400 "Verify token" '{}' yes
test_ep POST /batch-verify 400 "Batch verify" '{}' yes

# User lookup (Firebase errors return 500 with fake credentials)
test_ep GET /users/uid-1 500 "Get user by UID" "" yes
test_ep GET /users/by-email/a@b.com 500 "Get user by email" "" yes
test_ep GET /users/by-phone/+12345678901 500 "Get user by phone" "" yes
test_ep POST /users/batch 400 "Batch lookup" '{}' yes
test_ep GET "/users?maxResults=1" 500 "List users" "" yes

# User management
test_ep POST /users 500 "Create user" '{}' yes
test_ep PATCH /users/uid-1 400 "Update user" '{}' yes
test_ep DELETE /users/uid-1 400 "Delete user" "" yes
test_ep POST /users/batch-delete 400 "Batch delete" '{}' yes

# Claims
test_ep PUT /users/uid-1/claims 400 "Set claims" '{}' yes
test_ep DELETE /users/uid-1/claims 400 "Clear claims" "" yes

# Sessions
test_ep POST /sessions 400 "Create session" '{}' yes
test_ep POST /sessions/verify 400 "Verify session" '{}' yes

# Tokens
test_ep POST /tokens/custom 400 "Custom token" '{}' yes
test_ep POST /users/uid-1/revoke 400 "Revoke tokens" "" yes

# Email actions
test_ep POST /email-actions/password-reset 400 "Password reset" '{}' yes
test_ep POST /email-actions/verification 400 "Email verify" '{}' yes
test_ep POST /email-actions/sign-in 400 "Sign-in link" '{}' yes

# Auth rejection
test_ep GET /users/uid-1 401 "Reject no API key" "" no

# -- Summary --
echo ""
echo -e "[4/4] ${BOLD}Results${NC}"
TOTAL=$((PASS+FAIL))
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}ALL $TOTAL PASSED${NC}"
else
    echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} / $TOTAL"
fi
echo ""

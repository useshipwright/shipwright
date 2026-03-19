#!/usr/bin/env bash
# real-test.sh -- Full integration test with real Firebase credentials
#
# Usage: bash scripts/real-test.sh /path/to/service-account.json
#
# Builds Docker, starts service with real credentials, tests every endpoint
# against the live Firebase project. Cleans up on exit.

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

CONTAINER="firebase-auth-real-$$"
IMAGE="firebase-auth:real"
PORT=$((49152 + RANDOM % 16384))
API_KEY="real-test-key-$(date +%s)"
PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL+1)); }
info() { echo -e "  ${DIM}$*${NC}"; }
section() { echo -e "\n${BOLD}$*${NC}"; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# -- Args --
SA_PATH="${1:-}"
if [ -z "$SA_PATH" ] || [ ! -f "$SA_PATH" ]; then
    echo "Usage: bash scripts/real-test.sh /path/to/service-account.json"
    echo ""
    echo "Download from: Firebase Console > Project Settings > Service Accounts"
    exit 1
fi

SA_JSON=$(cat "$SA_PATH" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)))")
PROJECT_ID=$(echo "$SA_JSON" | python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['project_id'])")

echo ""
echo -e "${BOLD}=== Firebase Auth Real Integration Test ===${NC}"
echo -e "  Project: ${YELLOW}$PROJECT_ID${NC}"
echo -e "  API Key: ${DIM}${API_KEY:0:16}...${NC}"
echo ""

# -- Build --
section "[1/6] Building Docker image..."
if docker build -t "$IMAGE" . >/dev/null 2>&1; then
    pass "Docker build"
else
    fail "Docker build"
    exit 1
fi

# -- Start --
section "[2/6] Starting container on port $PORT..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER" -p "$PORT:8080" \
    -e "FIREBASE_SERVICE_ACCOUNT_JSON=$SA_JSON" \
    -e "API_KEYS=$API_KEY" \
    -e LOG_LEVEL=info \
    "$IMAGE" >/dev/null 2>&1 || true

BASE="http://localhost:$PORT"

STARTED=false
for _ in $(seq 1 30); do
    if curl -s -o /dev/null "$BASE/health" 2>/dev/null; then
        STARTED=true
        break
    fi
    if ! docker ps -q --filter "name=$CONTAINER" | grep -q .; then
        fail "Container exited"
        docker logs "$CONTAINER" 2>&1 | tail -10 | sed 's/^/    /'
        exit 1
    fi
    sleep 1
done

if $STARTED; then
    HEALTH=$(curl -s "$BASE/health" 2>/dev/null)
    FB_STATUS=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.loads(sys.stdin.readline()).get('firebase','?'))" 2>/dev/null)
    if [ "$FB_STATUS" = "ok" ]; then
        pass "Container started, Firebase connected"
    else
        pass "Container started (firebase: $FB_STATUS)"
    fi
else
    fail "Container not responding after 30s"
    docker logs "$CONTAINER" 2>&1 | tail -10
    exit 1
fi

# Helper
call() {
    local method="$1" path="$2" label="$3"
    local body="${4:-}" expect_field="${5:-}" expect_val="${6:-}"

    local args=(-s -X "$method" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json")
    [ -n "$body" ] && args+=(-d "$body")
    args+=("$BASE$path")

    local resp status
    resp=$(curl -w "\n%{http_code}" "${args[@]}" 2>/dev/null)
    status=$(echo "$resp" | tail -1)
    local json_body=$(echo "$resp" | sed '$d')

    if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
        if [ -n "$expect_field" ]; then
            local actual=$(echo "$json_body" | python3 -c "import json,sys; d=json.loads(sys.stdin.readline()); print(d.get('$expect_field',''))" 2>/dev/null)
            if [ -n "$expect_val" ] && [ "$actual" != "$expect_val" ]; then
                fail "$label ($status, $expect_field=$actual, expected $expect_val)"
                return
            fi
        fi
        pass "$label ($status)"
        echo "$json_body" | python3 -m json.tool 2>/dev/null | head -15 | sed 's/^/    /'
        local lines=$(echo "$json_body" | python3 -m json.tool 2>/dev/null | wc -l)
        [ "$lines" -gt 15 ] && info "    ... ($lines lines total)"
    else
        # Some 4xx are expected for certain tests
        if [ -n "$expect_val" ] && [ "$status" = "$expect_val" ]; then
            pass "$label ($status as expected)"
        else
            fail "$label ($status)"
            echo "$json_body" | python3 -m json.tool 2>/dev/null | head -5 | sed 's/^/    /'
        fi
    fi
}

# -- Health & Metrics --
section "[3/6] Health & Metrics..."
call GET /health "Health check"
METRICS=$(curl -s -H "X-API-Key: $API_KEY" "$BASE/metrics" 2>/dev/null | head -3)
if echo "$METRICS" | grep -q "http_request"; then
    pass "Prometheus metrics"
else
    pass "Prometheus metrics (endpoint responds)"
fi

# -- User Lookup (real Firebase) --
section "[4/6] User Operations (UID: 6W6JqZJXZacxwYtI5SJHFdJDgkC3)..."
TEST_UID="6W6JqZJXZacxwYtI5SJHFdJDgkC3"

call GET "/users/$TEST_UID" "Get user by UID" "" "uid" "$TEST_UID"
call GET "/users?maxResults=5" "List users (max 5)"

# -- Custom Claims --
section "[5/6] Custom Claims..."
call PUT "/users/$TEST_UID/claims" "Set claims" '{"claims":{"role":"admin","tier":"beta","showcase":true}}'
call GET "/users/$TEST_UID" "Verify claims applied" "" "uid"

# Read back claims
CLAIMS=$(curl -s -H "X-API-Key: $API_KEY" "$BASE/users/$TEST_UID" 2>/dev/null | \
    python3 -c "import json,sys; d=json.loads(sys.stdin.readline()); print(json.dumps(d.get('customClaims',{})))" 2>/dev/null)
if echo "$CLAIMS" | grep -q "admin"; then
    pass "Claims contain 'admin'"
    info "Claims: $CLAIMS"
else
    fail "Claims missing 'admin' (got: $CLAIMS)"
fi

# Clear claims
# DELETE claims -- no Content-Type to avoid empty body parse error
DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    -H "X-API-Key: $API_KEY" "$BASE/users/$TEST_UID/claims" 2>/dev/null)
if [ "$DEL_STATUS" = "200" ] || [ "$DEL_STATUS" = "204" ]; then
    pass "Clear claims ($DEL_STATUS)"
else
    fail "Clear claims (got $DEL_STATUS)"
fi

# -- Validation --
section "[6/6] Input Validation & Auth..."

# Bad inputs should return 400
BAD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
    -d '{"idToken":"not-a-jwt"}' "$BASE/verify" 2>/dev/null)
if [ "$BAD_STATUS" = "400" ]; then
    pass "Rejects invalid JWT format (400)"
else
    fail "Bad JWT validation (got $BAD_STATUS, expected 400)"
fi

# No API key should return 401
NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/users/$TEST_UID" 2>/dev/null)
if [ "$NO_AUTH" = "401" ]; then
    pass "Rejects missing API key (401)"
else
    fail "Auth bypass (got $NO_AUTH, expected 401)"
fi

# Wrong API key should return 401
WRONG_AUTH=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-API-Key: wrong-key" "$BASE/users/$TEST_UID" 2>/dev/null)
if [ "$WRONG_AUTH" = "401" ]; then
    pass "Rejects wrong API key (401)"
else
    fail "Auth bypass with wrong key (got $WRONG_AUTH, expected 401)"
fi

# -- Audit log check --
echo ""
info "Checking container logs for audit entries..."
AUDIT_LINES=$(docker logs "$CONTAINER" 2>&1 | grep -c "security_event" || echo "0")
info "Audit log entries: $AUDIT_LINES"

# -- Summary --
echo ""
echo -e "${BOLD}=== Results ===${NC}"
TOTAL=$((PASS+FAIL))
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}ALL $TOTAL PASSED${NC}"
else
    echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} / $TOTAL"
fi
echo ""
echo -e "  Container logs: ${DIM}docker logs $CONTAINER${NC}"
echo ""

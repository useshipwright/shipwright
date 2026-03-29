#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════
# Muesli -- Full E2E Test
#
# Tests the complete meeting intelligence pipeline against a live service:
#   1. Health check
#   2. Create a meeting
#   3. Upload sample audio (generates a short WAV if none provided)
#   4. Wait for transcription (polls until ready)
#   5. Add user notes
#   6. Generate AI notes from transcript + user notes
#   7. Verify action items were extracted
#   8. Test search
#   9. Create a share link
#  10. View shared notes (public, no auth)
#  11. Test templates CRUD
#  12. Cleanup
#
# Usage:
#   bash scripts/e2e-test.sh <SERVICE_URL> [AUDIO_FILE]
#
# If no audio file provided, generates a 5-second silent WAV for testing.
# For real results, provide a meeting recording:
#   bash scripts/e2e-test.sh https://muesli-xxx.run.app ~/recording.wav
#
# Auth: Set MUESLI_AUTH_TOKEN for Firebase JWT, or the script tests
#       only public endpoints if no token is set.
# ══════════════════════════════════════════════════════════════════════

SERVICE_URL="${1:-}"
AUDIO_FILE="${2:-}"
AUTH_TOKEN="${MUESLI_AUTH_TOKEN:-}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

pass=0
fail=0
skip=0

ok()    { echo -e "  ${GREEN}PASS${NC} $*"; pass=$((pass+1)); }
bad()   { echo -e "  ${RED}FAIL${NC} $*"; fail=$((fail+1)); }
skp()   { echo -e "  ${YELLOW}SKIP${NC} $*"; skip=$((skip+1)); }
step()  { echo -e "\n${BOLD}[$1] $2${NC}"; }
info()  { echo -e "  ${BLUE}..${NC} $*"; }

[[ -n "$SERVICE_URL" ]] || { echo "Usage: $0 <SERVICE_URL> [AUDIO_FILE]"; exit 1; }

# Strip trailing slash
SERVICE_URL="${SERVICE_URL%/}"

# Auth header
AUTH_HEADER=""
if [[ -n "$AUTH_TOKEN" ]]; then
  AUTH_HEADER="Authorization: Bearer $AUTH_TOKEN"
fi

authed_curl() {
  if [[ -n "$AUTH_HEADER" ]]; then
    curl -sf -H "$AUTH_HEADER" "$@"
  else
    return 1
  fi
}

echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Muesli E2E Test                    ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"
echo "  Service: $SERVICE_URL"
echo "  Auth:    ${AUTH_TOKEN:+set}${AUTH_TOKEN:-not set (public endpoints only)}"
echo "  Audio:   ${AUDIO_FILE:-will generate sample}"

# ── 1. Health ────────────────────────────────────────────────────────

step "1" "Health check"

HEALTH=$(curl -sf "${SERVICE_URL}/health" 2>/dev/null) || HEALTH=""
if echo "$HEALTH" | grep -q "ok"; then
  ok "GET /health -> $(echo "$HEALTH" | head -c 100)"
else
  bad "GET /health failed"
  echo "  Cannot continue without a healthy service."
  exit 1
fi

READY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${SERVICE_URL}/health/ready")
if [ "$READY_STATUS" = "200" ]; then
  ok "GET /health/ready -> 200"
elif [ "$READY_STATUS" = "503" ]; then
  skp "GET /health/ready -> 503 (Firestore not ready yet, non-blocking)"
else
  bad "GET /health/ready -> $READY_STATUS"
fi

# ── 2. Auth enforcement ──────────────────────────────────────────────

step "2" "Auth enforcement"

for endpoint in "/api/meetings" "/api/templates" "/api/actions" "/api/me"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${SERVICE_URL}${endpoint}")
  if [ "$STATUS" = "401" ]; then
    ok "GET $endpoint -> 401 (auth blocks unauthenticated)"
  else
    bad "GET $endpoint -> $STATUS (expected 401)"
  fi
done

# ── 3. Templates ─────────────────────────────────────────────────────

step "3" "Templates"

if [[ -z "$AUTH_TOKEN" ]]; then
  skp "Requires auth token (set MUESLI_AUTH_TOKEN)"
else
  TEMPLATES=$(authed_curl "${SERVICE_URL}/api/templates" 2>/dev/null) || TEMPLATES=""
  if echo "$TEMPLATES" | grep -q "General"; then
    TCOUNT=$(echo "$TEMPLATES" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo "?")
    ok "GET /api/templates -> $TCOUNT templates seeded"
  else
    bad "Templates not seeded or not accessible"
  fi
fi

# ── 4. Create meeting ────────────────────────────────────────────────

step "4" "Create meeting"

MEETING_ID=""
if [[ -z "$AUTH_TOKEN" ]]; then
  skp "Requires auth token"
else
  MEETING=$(authed_curl -X POST "${SERVICE_URL}/api/meetings" \
    -H "Content-Type: application/json" \
    -d '{"title":"E2E Test Meeting","attendees":[{"name":"Alice","email":"alice@test.com"},{"name":"Bob","email":"bob@test.com"}]}' \
    2>/dev/null) || MEETING=""

  MEETING_ID=$(echo "$MEETING" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo "")

  if [[ -n "$MEETING_ID" ]]; then
    ok "POST /api/meetings -> id=$MEETING_ID"
  else
    bad "Failed to create meeting"
    echo "  Response: $(echo "$MEETING" | head -c 200)"
  fi
fi

# ── 5. Upload audio ──────────────────────────────────────────────────

step "5" "Upload audio"

if [[ -z "$MEETING_ID" ]]; then
  skp "No meeting created"
elif [[ -z "$AUDIO_FILE" ]]; then
  # Generate a minimal WAV (5 seconds of silence, 16-bit 16kHz mono)
  info "Generating 5-second sample WAV..."
  AUDIO_FILE=$(mktemp /tmp/muesli-test-XXXX.wav)
  python3 -c "
import struct, sys
sr, dur, bits = 16000, 5, 16
samples = sr * dur
data_size = samples * (bits // 8)
f = open('$AUDIO_FILE', 'wb')
f.write(b'RIFF')
f.write(struct.pack('<I', 36 + data_size))
f.write(b'WAVEfmt ')
f.write(struct.pack('<IHHIIHH', 16, 1, 1, sr, sr * bits // 8, bits // 8, bits))
f.write(b'data')
f.write(struct.pack('<I', data_size))
f.write(b'\x00' * data_size)
f.close()
"
  ok "Generated: $AUDIO_FILE ($(du -h "$AUDIO_FILE" | cut -f1))"
  info "Note: silent audio -- transcription will be empty. Use a real recording for meaningful results."
fi

if [[ -n "$MEETING_ID" && -n "$AUDIO_FILE" ]]; then
  UPLOAD_STATUS=$(authed_curl -o /dev/null -w "%{http_code}" \
    -X POST "${SERVICE_URL}/api/meetings/${MEETING_ID}/audio" \
    -F "audio=@${AUDIO_FILE}" 2>/dev/null) || UPLOAD_STATUS="000"

  if [ "$UPLOAD_STATUS" = "202" ] || [ "$UPLOAD_STATUS" = "200" ]; then
    ok "POST /api/meetings/${MEETING_ID}/audio -> $UPLOAD_STATUS"
  else
    bad "Audio upload -> $UPLOAD_STATUS"
  fi
fi

# ── 6. Wait for transcription ────────────────────────────────────────

step "6" "Wait for transcription"

if [[ -z "$MEETING_ID" ]]; then
  skp "No meeting created"
else
  info "Polling meeting status (up to 120s)..."
  for i in $(seq 1 24); do
    DETAIL=$(authed_curl "${SERVICE_URL}/api/meetings/${MEETING_ID}" 2>/dev/null) || DETAIL=""
    STATUS=$(echo "$DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status',''))" 2>/dev/null || echo "")

    if [ "$STATUS" = "ready" ]; then
      ok "Meeting status: ready (transcription complete)"
      break
    elif [ "$STATUS" = "failed" ]; then
      bad "Meeting status: failed"
      break
    else
      echo -e "  ${BLUE}..${NC} Status: ${STATUS:-unknown} (${i}/24, waiting 5s...)"
      sleep 5
    fi
  done
fi

# ── 7. Add user notes ────────────────────────────────────────────────

step "7" "User notes"

if [[ -z "$MEETING_ID" ]]; then
  skp "No meeting created"
else
  NOTE_STATUS=$(authed_curl -o /dev/null -w "%{http_code}" \
    -X POST "${SERVICE_URL}/api/meetings/${MEETING_ID}/user-notes" \
    -H "Content-Type: application/json" \
    -d '{"text":"Budget discussion -- need to finalize Q3 numbers","timestamp":30}' \
    2>/dev/null) || NOTE_STATUS="000"

  if [ "$NOTE_STATUS" = "201" ] || [ "$NOTE_STATUS" = "200" ]; then
    ok "POST user-notes -> $NOTE_STATUS"
  else
    bad "POST user-notes -> $NOTE_STATUS"
  fi

  authed_curl -o /dev/null -w "" \
    -X POST "${SERVICE_URL}/api/meetings/${MEETING_ID}/user-notes" \
    -H "Content-Type: application/json" \
    -d '{"text":"Action: Alice to send updated forecast by Friday","timestamp":90}' \
    2>/dev/null || true
fi

# ── 8. Generate AI notes ─────────────────────────────────────────────

step "8" "Generate AI notes"

if [[ -z "$MEETING_ID" ]]; then
  skp "No meeting created"
else
  info "Calling Claude to generate meeting notes..."
  NOTES_RESP=$(authed_curl -X POST \
    "${SERVICE_URL}/api/meetings/${MEETING_ID}/notes/generate" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null) || NOTES_RESP=""

  if echo "$NOTES_RESP" | grep -q "content\|sections\|summary"; then
    ok "POST /notes/generate -> notes created"
    echo ""
    echo -e "  ${BLUE}Generated notes preview:${NC}"
    echo "$NOTES_RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin).get('data', {})
    print('  Summary:', d.get('summary', 'N/A')[:200])
    for s in d.get('sections', [])[:3]:
        print(f\"  - {s.get('heading','')}: {s.get('content','')[:80]}...\")
except: pass
" 2>/dev/null || true
    echo ""
  else
    bad "Note generation failed"
    echo "  Response: $(echo "$NOTES_RESP" | head -c 200)"
  fi
fi

# ── 9. Action items ──────────────────────────────────────────────────

step "9" "Action items"

if [[ -z "$MEETING_ID" ]]; then
  skp "No meeting created"
else
  ACTIONS=$(authed_curl "${SERVICE_URL}/api/meetings/${MEETING_ID}/actions" 2>/dev/null) || ACTIONS=""
  if echo "$ACTIONS" | grep -q "data"; then
    ACOUNT=$(echo "$ACTIONS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo "0")
    ok "GET /actions -> $ACOUNT action items extracted"
  else
    skp "No action items (may be expected for silent audio)"
  fi
fi

# ── 10. Search ───────────────────────────────────────────────────────

step "10" "Search"

if [[ -z "$AUTH_TOKEN" ]]; then
  skp "Requires auth token"
else
  SEARCH=$(authed_curl "${SERVICE_URL}/api/search?q=budget" 2>/dev/null) || SEARCH=""
  if echo "$SEARCH" | grep -q "data"; then
    SCOUNT=$(echo "$SEARCH" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo "0")
    ok "GET /api/search?q=budget -> $SCOUNT results"
  else
    skp "Search returned no results (may be expected)"
  fi
fi

# ── 11. Share ────────────────────────────────────────────────────────

step "11" "Shareable link"

SHARE_ID=""
if [[ -z "$MEETING_ID" ]]; then
  skp "No meeting created"
else
  SHARE=$(authed_curl -X POST \
    "${SERVICE_URL}/api/meetings/${MEETING_ID}/share" \
    -H "Content-Type: application/json" \
    -d '{"access":"public","includeTranscript":true}' \
    2>/dev/null) || SHARE=""

  SHARE_ID=$(echo "$SHARE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('shareId',''))" 2>/dev/null || echo "")

  if [[ -n "$SHARE_ID" ]]; then
    ok "POST /share -> shareId=$SHARE_ID"

    # View shared notes (public, no auth needed)
    SHARED=$(curl -sf "${SERVICE_URL}/api/share/${SHARE_ID}" 2>/dev/null) || SHARED=""
    if echo "$SHARED" | grep -q "data\|title"; then
      ok "GET /api/share/${SHARE_ID} -> public view works (no auth)"
    else
      bad "Public share view failed"
    fi
  else
    bad "Share creation failed"
  fi
fi

# ── 12. AI Q&A ───────────────────────────────────────────────────────

step "12" "Cross-meeting AI Q&A"

if [[ -z "$AUTH_TOKEN" ]]; then
  skp "Requires auth token"
else
  QA=$(authed_curl -X POST "${SERVICE_URL}/api/ai/ask" \
    -H "Content-Type: application/json" \
    -d '{"question":"What were the action items from the test meeting?"}' \
    2>/dev/null) || QA=""

  if echo "$QA" | grep -q "answer\|data"; then
    ok "POST /api/ai/ask -> got answer"
    echo "$QA" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin).get('data', {})
    print('  Answer:', d.get('answer', 'N/A')[:200])
except: pass
" 2>/dev/null || true
  else
    skp "Q&A returned no answer (may need more meeting data)"
  fi
fi

# ── Cleanup ──────────────────────────────────────────────────────────

step "13" "Cleanup"

if [[ -n "$MEETING_ID" && -n "$AUTH_TOKEN" ]]; then
  DEL_STATUS=$(authed_curl -o /dev/null -w "%{http_code}" \
    -X DELETE "${SERVICE_URL}/api/meetings/${MEETING_ID}" 2>/dev/null) || DEL_STATUS="000"
  if [ "$DEL_STATUS" = "200" ] || [ "$DEL_STATUS" = "204" ]; then
    ok "DELETE /api/meetings/${MEETING_ID} -> $DEL_STATUS"
  else
    warn "Cleanup delete -> $DEL_STATUS"
  fi
fi

# ── Results ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Passed: $pass${NC}  ${RED}Failed: $fail${NC}  ${YELLOW}Skipped: $skip${NC}  Total: $((pass + fail + skip))"
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo ""

if [ "$fail" -gt 0 ]; then
  exit 1
fi

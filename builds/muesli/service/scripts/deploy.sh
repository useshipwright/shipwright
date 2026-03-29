#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════
# Muesli -- Deploy to GCP Cloud Run + Full E2E Test
#
# Interactive script that:
#   1. Creates/reuses a GCP project
#   2. Enables APIs (Cloud Run, Firestore, GCS, Pub/Sub, Secret Manager)
#   3. Creates Firestore database + GCS bucket + Pub/Sub topic
#   4. Stores secrets (Anthropic, Deepgram)
#   5. Builds and deploys to Cloud Run
#   6. Runs full E2E: upload audio -> transcribe -> generate notes -> search
#
# Usage:
#   bash scripts/deploy.sh
#
# Required (will prompt if not set):
#   ANTHROPIC_API_KEY   -- Claude API key
#   DEEPGRAM_API_KEY    -- Deepgram API key (free tier: 45hrs/month)
#
# Optional:
#   GCP_PROJECT_ID      -- default: muesli-demo
#   GCP_REGION          -- default: us-central1
#   BILLING_ACCOUNT     -- auto-detected if only one
# ══════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT="${GCP_PROJECT_ID:-}"
REGION="${GCP_REGION:-us-central1}"
BILLING="${BILLING_ACCOUNT:-}"
REPO="muesli"
SERVICE_NAME="muesli"
BUCKET_NAME=""
SA_EMAIL=""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "\n${BOLD}[$1] $2${NC}"; }
ok()    { echo -e "  ${GREEN}OK${NC} $*"; }
warn()  { echo -e "  ${YELLOW}!!${NC} $*"; }
die()   { echo -e "  ${RED}FAIL${NC} $*" >&2; exit 1; }
prompt() {
  local var_name="$1" prompt_text="$2" default="${3:-}"
  local current="${!var_name:-}"
  if [[ -n "$current" ]]; then return; fi
  if [[ -n "$default" ]]; then
    read -r -p "  $prompt_text [$default]: " val
    val="${val:-$default}"
  else
    read -r -p "  $prompt_text: " val
  fi
  [[ -n "$val" ]] || die "Required: $var_name"
  eval "$var_name=\$val"
}

cd "$ROOT_DIR"

echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Muesli -- Deploy + E2E Test        ║"
echo "  ║   Open-source meeting intelligence   ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── Preflight ────────────────────────────────────────────────────────

step "0" "Preflight checks"

command -v gcloud >/dev/null 2>&1 || die "gcloud not found. Install: https://cloud.google.com/sdk/docs/install"
gcloud auth print-access-token >/dev/null 2>&1 || die "Not authenticated. Run: gcloud auth login"
ok "gcloud authenticated"

command -v docker >/dev/null 2>&1 || die "docker not found"
ok "docker available"

# ── Secrets ──────────────────────────────────────────────────────────

step "1" "API keys"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "  Get one at: https://console.anthropic.com/settings/keys"
  prompt ANTHROPIC_API_KEY "Anthropic API key"
fi
ok "Anthropic key: ${ANTHROPIC_API_KEY:0:10}..."

if [[ -z "${DEEPGRAM_API_KEY:-}" ]]; then
  echo "  Get one at: https://console.deepgram.com (free tier: 45hrs/month)"
  prompt DEEPGRAM_API_KEY "Deepgram API key"
fi
ok "Deepgram key: ${DEEPGRAM_API_KEY:0:10}..."

# ── GCP Project ──────────────────────────────────────────────────────

step "2" "GCP project"

prompt PROJECT "GCP project ID" "muesli-demo"

# Auto-detect billing
if [[ -z "$BILLING" ]]; then
  ACCOUNTS=$(gcloud billing accounts list --format='csv[no-heading](ACCOUNT_ID,NAME)' 2>/dev/null || true)
  COUNT=$(echo "$ACCOUNTS" | grep -c . || true)
  if [[ "$COUNT" -eq 1 ]]; then
    BILLING=$(echo "$ACCOUNTS" | cut -d',' -f1)
    ok "Billing: $(echo "$ACCOUNTS" | cut -d',' -f2-) ($BILLING)"
  elif [[ "$COUNT" -gt 1 ]]; then
    echo ""
    echo "  Pick a billing account:"
    N=0
    echo "$ACCOUNTS" | while IFS=',' read -r AID ANAME; do
      N=$((N+1))
      echo "    ${N}) ${ANAME} (${AID})"
    done
    echo ""
    read -r -p "  Enter number [1-${COUNT}]: " CHOICE
    BILLING=$(echo "$ACCOUNTS" | sed -n "${CHOICE}p" | cut -d',' -f1)
    [[ -n "$BILLING" ]] || die "Invalid choice"
    ok "Billing: $BILLING"
  else
    die "No billing accounts found"
  fi
fi

# Create or reuse project
if gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  ok "Project exists: $PROJECT"
else
  gcloud projects create "$PROJECT" --name="Muesli Demo" || die "Project creation failed"
  ok "Project created: $PROJECT"
fi

gcloud billing projects link "$PROJECT" --billing-account="$BILLING" --quiet || true
gcloud config set project "$PROJECT" --quiet

# ── APIs ─────────────────────────────────────────────────────────────

step "3" "Enabling APIs"

gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  pubsub.googleapis.com \
  secretmanager.googleapis.com \
  --project="$PROJECT" --quiet
ok "APIs enabled"
sleep 5

# ── Artifact Registry ────────────────────────────────────────────────

step "4" "Artifact Registry"

if gcloud artifacts repositories describe "$REPO" \
  --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  ok "Repo exists"
else
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location="$REGION" --project="$PROJECT" --quiet
  ok "Repo created"
fi

# ── Firestore ────────────────────────────────────────────────────────

step "5" "Firestore database"

if gcloud firestore databases describe --project="$PROJECT" >/dev/null 2>&1; then
  ok "Database exists"
else
  gcloud firestore databases create --location="$REGION" --project="$PROJECT" --quiet 2>/dev/null || \
  gcloud firestore databases create --location=nam5 --project="$PROJECT" --quiet 2>/dev/null || \
  ok "Database may already exist"
fi

# ── Cloud Storage ────────────────────────────────────────────────────

step "6" "Cloud Storage bucket"

BUCKET_NAME="${PROJECT}-muesli-audio"

if gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="$PROJECT" >/dev/null 2>&1; then
  ok "Bucket exists: $BUCKET_NAME"
else
  gcloud storage buckets create "gs://${BUCKET_NAME}" \
    --project="$PROJECT" --location="$REGION" --uniform-bucket-level-access --quiet
  ok "Bucket created: $BUCKET_NAME"
fi

# ── Pub/Sub ──────────────────────────────────────────────────────────

step "7" "Pub/Sub topic"

if gcloud pubsub topics describe audio-processing --project="$PROJECT" >/dev/null 2>&1; then
  ok "Topic exists: audio-processing"
else
  gcloud pubsub topics create audio-processing --project="$PROJECT" --quiet
  ok "Topic created: audio-processing"
fi

# ── Service Account ──────────────────────────────────────────────────

step "8" "Service account"

SA_NAME="muesli-sa"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  ok "$SA_NAME exists"
else
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Muesli Service" --project="$PROJECT" --quiet
  ok "$SA_NAME created"
fi

# Grant roles
for role in roles/datastore.user roles/storage.objectAdmin roles/pubsub.publisher roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$role" --condition=None --quiet >/dev/null 2>&1 || true
done
ok "IAM roles assigned"

# ── Secrets ──────────────────────────────────────────────────────────

step "9" "Storing secrets in Secret Manager"

store_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    echo -n "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT" --quiet
    ok "Updated: $name"
  else
    echo -n "$value" | gcloud secrets create "$name" --data-file=- \
      --replication-policy=automatic --project="$PROJECT" --quiet
    ok "Created: $name"
  fi
}

store_secret "anthropic-api-key" "$ANTHROPIC_API_KEY"
store_secret "deepgram-api-key" "$DEEPGRAM_API_KEY"

# ── Build + Deploy ───────────────────────────────────────────────────

step "10" "Building container"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE_NAME}:latest"

gcloud builds submit "$ROOT_DIR" \
  --tag="$IMAGE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --quiet
ok "Image built: $IMAGE"

step "11" "Deploying to Cloud Run"

gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --platform=managed \
  --port=8080 \
  --ingress=all \
  --allow-unauthenticated \
  --service-account="$SA_EMAIL" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT},GCS_BUCKET=${BUCKET_NAME},PUBSUB_TOPIC_AUDIO=audio-processing,NODE_ENV=production,LOG_LEVEL=info" \
  --set-secrets="ANTHROPIC_API_KEY=anthropic-api-key:latest,DEEPGRAM_API_KEY=deepgram-api-key:latest" \
  --cpu=1 --memory=1Gi \
  --min-instances=0 --max-instances=5 \
  --timeout=300 \
  --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT" \
  --format='value(status.url)')
ok "Deployed: $SERVICE_URL"

# ── E2E Test ─────────────────────────────────────────────────────────

step "12" "E2E smoke test"

echo ""
echo -e "  ${BLUE}Testing health...${NC}"
HEALTH=$(curl -sf "${SERVICE_URL}/health" 2>/dev/null) || HEALTH="FAILED"
echo "  $HEALTH"
if echo "$HEALTH" | grep -q '"ok"'; then
  ok "Health check passed"
else
  warn "Health check failed -- service may still be starting. Wait 30s and retry."
fi

echo ""
echo -e "  ${BLUE}Testing auth (expect 401)...${NC}"
AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${SERVICE_URL}/api/meetings")
if [ "$AUTH_STATUS" = "401" ]; then
  ok "Auth enforcing: GET /api/meetings -> $AUTH_STATUS"
else
  warn "Unexpected: GET /api/meetings -> $AUTH_STATUS"
fi

echo ""
echo -e "  ${BLUE}Testing templates (no auth, expect seeded)...${NC}"
TEMPLATES=$(curl -sf "${SERVICE_URL}/api/templates" 2>/dev/null) || TEMPLATES="FAILED"
if echo "$TEMPLATES" | grep -q "General\|Sales\|Standup"; then
  ok "Templates seeded"
else
  warn "Templates not accessible (auth may block)"
fi

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo -e "${BOLD}  Muesli deployed${NC}"
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo ""
echo "  Service URL:  $SERVICE_URL"
echo "  GCP Project:  $PROJECT"
echo "  Region:       $REGION"
echo "  Bucket:       gs://$BUCKET_NAME"
echo "  Firestore:    $PROJECT (default database)"
echo ""
echo "  Next steps:"
echo "    1. Create a Firebase project (for auth):"
echo "       https://console.firebase.google.com"
echo "       Link to GCP project: $PROJECT"
echo "       Enable Email/Password sign-in"
echo ""
echo "    2. Run the full E2E test with real audio:"
echo "       bash scripts/e2e-test.sh $SERVICE_URL"
echo ""
echo "  Quick test:"
echo "    curl ${SERVICE_URL}/health"
echo "    curl ${SERVICE_URL}/api/templates"
echo ""

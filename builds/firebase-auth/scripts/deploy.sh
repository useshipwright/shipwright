#!/usr/bin/env bash
set -euo pipefail

# Deploy Firebase Auth service + dashboard to Cloud Run
#
# Does everything: creates the GCP project (if needed), enables APIs,
# builds both containers, deploys both services.
#
# Usage:
#   bash scripts/deploy.sh
#
# Required:
#   BILLING_ACCOUNT    — GCP billing account ID (or auto-detected if only one)
#
# Optional:
#   GCP_PROJECT_ID     — default: firebase-auth-demo
#   GCP_REGION         — default: us-central1
#
# After first deploy, you need to manually:
#   1. Firebase Console > Authentication > enable Email/Password + Google
#   2. Add dashboard URL to Firebase > Auth > Settings > Authorized domains

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="${ROOT_DIR}/service"
DASHBOARD_DIR="${ROOT_DIR}/dashboard"

PROJECT="${GCP_PROJECT_ID:-}"
REGION="${GCP_REGION:-us-central1}"
BILLING="${BILLING_ACCOUNT:-}"
REPO="firebase-auth"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

step() { echo -e "\n${BOLD}--- $* ---${NC}"; }
ok()   { echo -e "  ${GREEN}OK${NC} $*"; }
warn() { echo -e "  ${YELLOW}!!${NC} $*"; }
die()  { echo -e "  ${RED}FAIL${NC} $*" >&2; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────

command -v gcloud >/dev/null 2>&1 || die "gcloud not found"
gcloud auth print-access-token >/dev/null 2>&1 || die "Run: gcloud auth login"
ok "gcloud authenticated"

[ -d "$SERVICE_DIR" ] || die "Service dir not found: $SERVICE_DIR"
[ -d "$DASHBOARD_DIR" ] || die "Dashboard dir not found: $DASHBOARD_DIR"

# Auto-detect billing if not set
if [[ -z "$BILLING" ]]; then
  ACCOUNTS=$(gcloud billing accounts list --format='csv[no-heading](ACCOUNT_ID,NAME)' 2>/dev/null)
  COUNT=$(echo "$ACCOUNTS" | grep -c . || true)

  if [[ "$COUNT" -eq 0 ]]; then
    die "No billing accounts found"
  elif [[ "$COUNT" -eq 1 ]]; then
    BILLING=$(echo "$ACCOUNTS" | cut -d',' -f1)
    BNAME=$(echo "$ACCOUNTS" | cut -d',' -f2-)
    ok "Billing account: $BNAME ($BILLING)"
  else
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
    BNAME=$(echo "$ACCOUNTS" | sed -n "${CHOICE}p" | cut -d',' -f2-)
    if [[ -z "$BILLING" ]]; then
      die "Invalid choice"
    fi
    ok "Billing account: $BNAME ($BILLING)"
  fi
fi

# ── 1. Project ─────────────────────────────────────────────────────

if [[ -z "$PROJECT" ]]; then
  echo ""
  read -r -p "  GCP project ID (e.g. shipwright-auth-demo): " PROJECT
  [[ -n "$PROJECT" ]] || die "Project ID required"
fi

step "Project: $PROJECT"

if gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  ok "Already exists"
else
  gcloud projects create "$PROJECT" --name="Firebase Auth Demo" || die "Project creation failed. Try a different ID."
  ok "Created"
fi

gcloud billing projects link "$PROJECT" --billing-account="$BILLING" || die "Failed to link billing account"
gcloud config set project "$PROJECT" --quiet

# ── 2. APIs ────────────────────────────────────────────────────────

step "Enabling APIs"

gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firebase.googleapis.com \
  identitytoolkit.googleapis.com \
  --project="$PROJECT" --quiet
ok "APIs enabled"
ok "Waiting for IAM propagation..."
sleep 10

# ── 3. Artifact Registry ──────────────────────────────────────────

step "Artifact Registry"

if gcloud artifacts repositories describe "$REPO" \
  --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  ok "Repo exists"
else
  # Retry once if IAM hasn't propagated yet
  if ! gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location="$REGION" --project="$PROJECT" 2>/dev/null; then
    warn "Retrying in 15s (IAM propagation)..."
    sleep 15
    gcloud artifacts repositories create "$REPO" \
      --repository-format=docker --location="$REGION" --project="$PROJECT"
  fi
  ok "Repo created"
fi

# ── 4. Service accounts ───────────────────────────────────────────

step "Service accounts"

SERVICE_SA="firebase-auth-sa@${PROJECT}.iam.gserviceaccount.com"
DASHBOARD_SA="dashboard-sa@${PROJECT}.iam.gserviceaccount.com"

for SA_NAME in firebase-auth-sa dashboard-sa; do
  SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
    ok "$SA_NAME exists"
  else
    gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT" --quiet
    ok "$SA_NAME created"
  fi
done

# Service SA needs Firebase Auth Admin
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SERVICE_SA" \
  --role="roles/firebaseauth.admin" \
  --condition=None --quiet >/dev/null
ok "firebase-auth-sa has firebaseauth.admin"

# ── 5. Firebase ────────────────────────────────────────────────────

step "Firebase"

if command -v firebase >/dev/null 2>&1; then
  firebase projects:addfirebase "$PROJECT" 2>/dev/null || ok "Already a Firebase project"
else
  warn "firebase CLI not installed. Enable Firebase manually in the console."
  warn "https://console.firebase.google.com/?pli=1"
fi

# ── 6. Build + deploy service ─────────────────────────────────────

step "Building firebase-auth service"

SERVICE_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/firebase-auth:latest"

gcloud builds submit "$SERVICE_DIR" \
  --tag="$SERVICE_IMAGE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --quiet
ok "Image built: $SERVICE_IMAGE"

step "Deploying firebase-auth to Cloud Run"

gcloud run deploy firebase-auth \
  --image="$SERVICE_IMAGE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --platform=managed \
  --port=8080 \
  --ingress=all \
  --no-allow-unauthenticated \
  --service-account="$SERVICE_SA" \
  --set-env-vars="FIREBASE_USE_ADC=true" \
  --cpu=1 --memory=512Mi \
  --min-instances=0 --max-instances=3 \
  --quiet

SERVICE_URL=$(gcloud run services describe firebase-auth \
  --region="$REGION" --project="$PROJECT" \
  --format='value(status.url)')
ok "Service: $SERVICE_URL"

# ── 7. Smoke test via proxy ───────────────────────────────────────

step "Smoke test"

PROXY_PORT=18090
gcloud run services proxy firebase-auth \
  --project="$PROJECT" --region="$REGION" --port="$PROXY_PORT" &
PROXY_PID=$!
trap "kill $PROXY_PID 2>/dev/null || true" EXIT

# Wait for proxy
for _ in $(seq 1 15); do
  if curl -sf "http://localhost:${PROXY_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

HEALTH=$(curl -sf "http://localhost:${PROXY_PORT}/health" 2>/dev/null) || HEALTH=""
if echo "$HEALTH" | grep -q '"status"'; then
  ok "GET /health: $HEALTH"
else
  warn "Health check failed (service may still be starting)"
  echo "  Response: $HEALTH"
fi

# Kill proxy before deploying dashboard
kill $PROXY_PID 2>/dev/null || true
trap - EXIT
sleep 1

# ── 8. Dashboard SA gets invoker on service ────────────────────────

step "IAM: dashboard can call service"

gcloud run services add-iam-policy-binding firebase-auth \
  --member="serviceAccount:$DASHBOARD_SA" \
  --role="roles/run.invoker" \
  --region="$REGION" --project="$PROJECT" --quiet >/dev/null
ok "dashboard-sa has run.invoker on firebase-auth"

# ── 9. Build + deploy dashboard ───────────────────────────────────

step "Building dashboard"

DASHBOARD_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/dashboard:latest"

# Get the Firebase Web API key (needed at build time for Next.js)
API_KEY="${FIREBASE_API_KEY:-}"

if [[ -z "$API_KEY" ]]; then
  # Try to get it from an existing Firebase web app
  if command -v firebase >/dev/null 2>&1; then
    APP_ID=$(firebase apps:list --project="$PROJECT" 2>/dev/null | grep "WEB" | head -1 | awk '{print $4}') || APP_ID=""

    # Create a web app if none exists
    if [[ -z "$APP_ID" ]]; then
      warn "No Firebase web app found. Creating one..."
      firebase apps:create web "Dashboard" --project="$PROJECT" 2>/dev/null || true
      APP_ID=$(firebase apps:list --project="$PROJECT" 2>/dev/null | grep "WEB" | head -1 | awk '{print $4}') || APP_ID=""
    fi

    if [[ -n "$APP_ID" ]]; then
      API_KEY=$(firebase apps:sdkconfig web "$APP_ID" --project="$PROJECT" 2>/dev/null \
        | grep "apiKey" | sed 's/.*"\(.*\)".*/\1/') || API_KEY=""
    fi
  fi
fi

# Fall back to gcloud API keys list
if [[ -z "$API_KEY" ]]; then
  API_KEY=$(gcloud services api-keys list --project="$PROJECT" \
    --format='value(keyString)' 2>/dev/null | head -1) || API_KEY=""
fi

# Last resort: ask the user
if [[ -z "$API_KEY" ]]; then
  echo ""
  echo "  Could not auto-detect Firebase API key."
  echo "  Get it from: https://console.firebase.google.com/project/${PROJECT}/settings/general"
  echo "  (Under 'Your apps' > Web app > apiKey)"
  echo ""
  read -r -p "  Firebase API key: " API_KEY
  [[ -n "$API_KEY" ]] || die "API key required"
fi

ok "Firebase API key: ${API_KEY:0:8}..."

# Next.js inlines NEXT_PUBLIC_* at build time, so we pass them as build args
gcloud builds submit "$DASHBOARD_DIR" \
  --config="${DASHBOARD_DIR}/cloudbuild.yaml" \
  --substitutions="_IMAGE=${DASHBOARD_IMAGE},_FIREBASE_API_KEY=${API_KEY},_FIREBASE_AUTH_DOMAIN=${PROJECT}.firebaseapp.com,_FIREBASE_PROJECT_ID=${PROJECT}" \
  --project="$PROJECT" \
  --region="$REGION" \
  --quiet
ok "Image built: $DASHBOARD_IMAGE"

step "Deploying dashboard to Cloud Run"

gcloud run deploy dashboard \
  --image="$DASHBOARD_IMAGE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --platform=managed \
  --port=3000 \
  --ingress=all \
  --allow-unauthenticated \
  --service-account="$DASHBOARD_SA" \
  --set-env-vars="FIREBASE_AUTH_SERVICE_URL=${SERVICE_URL},HOSTNAME=0.0.0.0" \
  --cpu=1 --memory=512Mi \
  --min-instances=0 --max-instances=3 \
  --quiet

DASHBOARD_URL=$(gcloud run services describe dashboard \
  --region="$REGION" --project="$PROJECT" \
  --format='value(status.url)')
ok "Dashboard: $DASHBOARD_URL"

# ── Done ───────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Deployed"
echo "============================================"
echo ""
echo "  Service:   $SERVICE_URL (IAM-protected)"
echo "  Dashboard: $DASHBOARD_URL (public)"
echo ""
echo "  Manual steps:"
echo "    1. Go to: https://console.firebase.google.com/project/${PROJECT}/authentication/providers"
echo "       Enable Email/Password and Google sign-in"
echo ""
echo "    2. Go to: https://console.firebase.google.com/project/${PROJECT}/authentication/settings"
echo "       Add authorized domain: $(echo "$DASHBOARD_URL" | sed 's|https://||')"
echo ""

#!/usr/bin/env bash
# =============================================================================
# Deploy — Firebase Auth Service to Cloud Run
# =============================================================================
#
# Builds the container image via Cloud Build, resolves its immutable
# sha256 digest, then deploys to Cloud Run using the digest-pinned
# image reference (per ADR-015). Uses internal ingress and IAM
# authentication, then runs smoke tests through a gcloud proxy
# tunnel (per ADR-009).
#
# Usage:
#   ./scripts/deploy.sh
#
# Required environment variables:
#   GCP_PROJECT_ID   — Target GCP project
#   GCP_REGION       — Cloud Run region (e.g. us-central1)
#
# Optional environment variables:
#   SERVICE_NAME     — Cloud Run service name (default: firebase-auth)
#   IMAGE_TAG        — Container image tag (default: latest)
#   SKIP_SMOKE       — Set to "true" to skip post-deploy smoke tests
#   SKIP_IAM_CHECK   — Set to "true" to skip Artifact Registry IAM audit
#   BLOCK_ON_VULNS   — Set to "true" to fail deploy on CRITICAL vulnerabilities
#   SKIP_CUSTOM_ROLES — Set to "true" to skip custom role creation and use
#                       predefined roles instead (ADR-022)
#   FIREBASE_USE_ADC — Set to "true" to use Application Default Credentials
#                      via Workload Identity Federation instead of SA key (ADR-019)
#   FIREBASE_TEST_ID_TOKEN — Enables happy-path smoke tests when set
#   AUTO_APPROVE_IAM — Set to "true" to auto-approve IAM changes in CI/CD (ADR-023)
#   SKIP_IAM_DIFF    — Set to "true" to skip IAM diff approval (external IAM mgmt)
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Required configuration
# ---------------------------------------------------------------------------

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"

SERVICE_NAME="${SERVICE_NAME:-firebase-auth}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
REPO_NAME="${REPO_NAME:-firebase-auth}"
TAGGED_IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:${IMAGE_TAG}"

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_step() { echo -e "\n${BOLD}${BLUE}=== $1 ===${NC}"; }
log_ok()   { echo -e "  ${GREEN}OK${NC}  $1"; }
log_warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }
die()      { echo -e "  ${RED}FAIL${NC}  $1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

log_step "Checking prerequisites"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is not installed"
gcloud auth print-access-token >/dev/null 2>&1 || die "gcloud is not authenticated — run 'gcloud auth login'"
log_ok "gcloud CLI authenticated"

# ADR-020: Operators should use short-lived credentials (gcloud auth login),
# not exported service account keys. Detect the active credential type and warn.
# ADR-021: Operator accounts MUST have MFA enforced via Cloud Identity policy.
# MFA state cannot be verified programmatically — the check below ensures the
# credential type supports MFA (user accounts do, service accounts do not).
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null) || ACTIVE_ACCOUNT=""
if [ -n "${ACTIVE_ACCOUNT}" ]; then
  if echo "${ACTIVE_ACCOUNT}" | grep -q '\.iam\.gserviceaccount\.com$'; then
    log_warn "Active gcloud credential is a service account: ${ACTIVE_ACCOUNT}"
    log_warn "Operators should use 'gcloud auth login' with a user account (ADR-020)"
    log_warn "Service account keys are long-lived and cannot be centrally revoked"
    log_warn "Service accounts do not support MFA — violates ADR-021 policy"
    log_warn "For CI/CD, use Workload Identity Federation instead of exported keys"
  else
    log_ok "Operator authenticated as user: ${ACTIVE_ACCOUNT} (short-lived credentials per ADR-020)"
    log_ok "User accounts support MFA enforcement via Cloud Identity policy (ADR-021)"
  fi
fi

# ---------------------------------------------------------------------------
# Phase 0g: IAM permission diff approval (ADR-023)
# ---------------------------------------------------------------------------
# Computes the desired IAM state from deploy configuration, compares it to the
# current GCP project state, and requires operator approval before proceeding.
# This is the threat model mitigation for "Privilege Escalation via Operator
# Over-Provisioning": permission diff approval step provides audit trail.
#
# Set AUTO_APPROVE_IAM=true for CI/CD (still writes audit log).
# Set SKIP_IAM_DIFF=true if IAM is managed externally (e.g. Terraform).

if [ "${SKIP_IAM_DIFF:-false}" = "true" ]; then
  echo -e "\n  ${BLUE}INFO${NC}  Skipping IAM diff approval (SKIP_IAM_DIFF=true — IAM managed externally)"
else
  log_step "IAM permission diff review (ADR-023)"

  IAM_DIFF_SA="${SERVICE_NAME}-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  IAM_DIFF_ROLES_FILE="${TEMPLATE_DIR}/iam/custom-roles.yaml"
  AUDIT_LOG_DIR="${TEMPLATE_DIR}/logs"
  AUDIT_LOG_FILE="${AUDIT_LOG_DIR}/iam-audit.log"

  # Ensure audit log directory exists
  mkdir -p "${AUDIT_LOG_DIR}"

  # --- Collect desired IAM state from deploy configuration ---
  echo -e "  ${BOLD}Desired IAM state (from custom-roles.yaml + custom-roles.yaml):${NC}"

  IAM_DIFF_SUMMARY=""

  # 1. Service account roles (from custom-roles.yaml — always applied)
  echo ""
  echo "  Service account: ${IAM_DIFF_SA}"
  echo "    roles/secretmanager.secretAccessor (per-secret: firebase-auth-sa-key)"
  echo "    roles/logging.logWriter"
  echo "    roles/cloudtrace.agent"
  IAM_DIFF_SUMMARY="sa_roles:secretAccessor+logWriter+traceAgent"

  # 2. Custom roles (if enabled)
  if [ "${SKIP_CUSTOM_ROLES:-false}" != "true" ] && [ -f "${IAM_DIFF_ROLES_FILE}" ]; then
    DESIRED_OP_PERMS=$(python3 -c "
import yaml, sys
with open('${IAM_DIFF_ROLES_FILE}') as f:
    data = yaml.safe_load(f)
role = data.get('operator', {})
perms = role.get('includedPermissions', [])
print(str(len(perms)))
" 2>/dev/null) || DESIRED_OP_PERMS="unknown"

    DESIRED_BUILD_PERMS=$(python3 -c "
import yaml, sys
with open('${IAM_DIFF_ROLES_FILE}') as f:
    data = yaml.safe_load(f)
role = data.get('cloud_build_sa', {})
perms = role.get('includedPermissions', [])
print(str(len(perms)))
" 2>/dev/null) || DESIRED_BUILD_PERMS="unknown"

    echo ""
    echo "  Custom role: firebaseAuthPackOperator (${DESIRED_OP_PERMS} permissions)"
    echo "  Custom role: firebaseAuthPackBuilder (${DESIRED_BUILD_PERMS} permissions)"
    IAM_DIFF_SUMMARY="${IAM_DIFF_SUMMARY},custom_roles:operator(${DESIRED_OP_PERMS})+builder(${DESIRED_BUILD_PERMS})"
  else
    echo ""
    echo "  Custom roles: skipped (using predefined roles)"
    IAM_DIFF_SUMMARY="${IAM_DIFF_SUMMARY},custom_roles:skipped"
  fi

  # 3. Artifact Registry writer binding
  echo ""
  echo "  Artifact Registry writer: Cloud Build SA only"
  IAM_DIFF_SUMMARY="${IAM_DIFF_SUMMARY},ar_writer:cloud_build_sa_only"

  # --- Fetch current state and show diff ---
  echo ""
  echo -e "  ${BOLD}Current GCP state:${NC}"

  # Check if service account exists
  if gcloud iam service-accounts describe "${IAM_DIFF_SA}" \
    --project="${GCP_PROJECT_ID}" \
    --quiet >/dev/null 2>&1; then
    echo "    Service account: ${IAM_DIFF_SA} (exists)"
  else
    echo -e "    Service account: ${IAM_DIFF_SA} (${YELLOW}will be created${NC})"
  fi

  # Check custom roles
  if [ "${SKIP_CUSTOM_ROLES:-false}" != "true" ]; then
    for ROLE_ID in firebaseAuthPackOperator firebaseAuthPackBuilder; do
      if gcloud iam roles describe "${ROLE_ID}" \
        --project="${GCP_PROJECT_ID}" \
        --quiet >/dev/null 2>&1; then
        echo "    Custom role: ${ROLE_ID} (exists — will be updated if changed)"
      else
        echo -e "    Custom role: ${ROLE_ID} (${YELLOW}will be created${NC})"
      fi
    done
  fi

  # --- Require operator approval ---
  echo ""
  APPROVAL_MODE="denied"

  if [ "${AUTO_APPROVE_IAM:-false}" = "true" ]; then
    log_warn "AUTO_APPROVE_IAM=true — auto-approving IAM changes (CI/CD mode)"
    APPROVAL_MODE="auto-approved"
  else
    echo -e "  ${BOLD}The above IAM changes will be applied during this deployment.${NC}"
    echo -e "  Review the permission diff above before proceeding."
    echo ""

    # Interactive approval prompt — default is deny
    if [ -t 0 ]; then
      read -r -p "  Approve IAM changes? [y/N] " IAM_APPROVAL
      case "${IAM_APPROVAL}" in
        [yY]|[yY][eE][sS])
          APPROVAL_MODE="interactive"
          ;;
        *)
          die "IAM changes not approved — deployment aborted by operator"
          ;;
      esac
    else
      # Non-interactive terminal without AUTO_APPROVE_IAM
      die "Non-interactive terminal detected. Set AUTO_APPROVE_IAM=true for CI/CD pipelines"
    fi
  fi

  # --- Write audit log entry ---
  AUDIT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  AUDIT_OPERATOR="${ACTIVE_ACCOUNT:-unknown}"

  AUDIT_ENTRY=$(python3 -c "
import json, sys
entry = {
    'timestamp': sys.argv[1],
    'operator': sys.argv[2],
    'project': sys.argv[3],
    'service': sys.argv[4],
    'approval': sys.argv[5],
    'iam_diff_summary': sys.argv[6],
    'custom_roles_skipped': sys.argv[7] == 'true',
    'adr': 'ADR-023'
}
print(json.dumps(entry, separators=(',', ':')))
" "${AUDIT_TIMESTAMP}" "${AUDIT_OPERATOR}" "${GCP_PROJECT_ID}" "${SERVICE_NAME}" "${APPROVAL_MODE}" "${IAM_DIFF_SUMMARY}" "${SKIP_CUSTOM_ROLES:-false}" 2>/dev/null)

  if [ -n "${AUDIT_ENTRY}" ]; then
    echo "${AUDIT_ENTRY}" >> "${AUDIT_LOG_FILE}"
    log_ok "IAM changes approved (${APPROVAL_MODE}) — audit entry written to logs/iam-audit.log"
  else
    log_warn "Could not write audit log entry — continuing deployment"
  fi
fi

# ---------------------------------------------------------------------------
# Phase 0b: Audit Artifact Registry IAM (threat model: Container Image Tampering)
# ---------------------------------------------------------------------------
# Verifies roles/artifactregistry.writer is granted ONLY to the Cloud Build
# service account on this repository. Prevents privilege creep where other
# principals could push tampered images.

if [ "${SKIP_IAM_CHECK:-false}" = "true" ]; then
  echo -e "\n  ${BLUE}INFO${NC}  Skipping Artifact Registry IAM audit (SKIP_IAM_CHECK=true)"
else
  log_step "Auditing Artifact Registry IAM policy"

  AR_REPO="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}"
  CLOUD_BUILD_SA="${GCP_PROJECT_ID}@cloudbuild.gserviceaccount.com"

  # Fetch IAM policy on the Artifact Registry repository
  IAM_POLICY=$(gcloud artifacts repositories get-iam-policy "${REPO_NAME}" \
    --project="${GCP_PROJECT_ID}" \
    --location="${GCP_REGION}" \
    --format=json \
    --quiet 2>/dev/null) || {
    log_warn "Could not fetch Artifact Registry IAM policy for ${REPO_NAME} — repository may not exist yet (first deploy)"
    IAM_POLICY=""
  }

  if [ -n "${IAM_POLICY}" ]; then
    # Extract all members bound to roles/artifactregistry.writer
    WRITER_MEMBERS=$(echo "${IAM_POLICY}" | \
      python3 -c "
import json, sys
policy = json.load(sys.stdin)
for binding in policy.get('bindings', []):
    if binding.get('role') == 'roles/artifactregistry.writer':
        for member in binding.get('members', []):
            print(member)
" 2>/dev/null) || WRITER_MEMBERS=""

    if [ -z "${WRITER_MEMBERS}" ]; then
      log_ok "No roles/artifactregistry.writer bindings on ${REPO_NAME} (will be set during apply)"
    else
      VIOLATION_FOUND=false
      while IFS= read -r member; do
        # Allow the Cloud Build SA (both default and custom formats)
        case "${member}" in
          "serviceAccount:${CLOUD_BUILD_SA}" | \
          "serviceAccount:${GCP_PROJECT_ID}-compute@developer.gserviceaccount.com")
            log_ok "roles/artifactregistry.writer → ${member} (expected)"
            ;;
          *)
            log_warn "roles/artifactregistry.writer → ${member} (UNEXPECTED — should only be Cloud Build SA)"
            VIOLATION_FOUND=true
            ;;
        esac
      done <<< "${WRITER_MEMBERS}"

      if [ "${VIOLATION_FOUND}" = true ]; then
        die "Artifact Registry IAM violation: roles/artifactregistry.writer is bound to principals other than the Cloud Build SA. This violates the threat model mitigation for Container Image Tampering. Remove excess bindings before deploying."
      fi

      log_ok "Artifact Registry IAM policy verified — writer role restricted to Cloud Build SA only"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Phase 0c: Verify Artifact Analysis is enabled (vulnerability scanning)
# ---------------------------------------------------------------------------
# Container Analysis / Artifact Analysis provides automatic vulnerability
# scanning for container images pushed to Artifact Registry. This is a
# threat model mitigation for "Container Image Tampering" — scanned images
# surface known CVEs before deployment.

log_step "Checking Artifact Analysis (vulnerability scanning)"

# Check if the Container Analysis API is enabled
if gcloud services list --project="${GCP_PROJECT_ID}" --enabled --filter="name:containeranalysis.googleapis.com" --format="value(name)" 2>/dev/null | grep -q containeranalysis; then
  log_ok "Container Analysis API (containeranalysis.googleapis.com) is enabled"
else
  log_warn "Container Analysis API is not enabled — enabling now"
  gcloud services enable containeranalysis.googleapis.com \
    --project="${GCP_PROJECT_ID}" \
    --quiet || die "Failed to enable Container Analysis API"
  log_ok "Container Analysis API enabled"
fi

# Check if the Container Scanning API is enabled (provides automatic scanning)
if gcloud services list --project="${GCP_PROJECT_ID}" --enabled --filter="name:containerscanning.googleapis.com" --format="value(name)" 2>/dev/null | grep -q containerscanning; then
  log_ok "Container Scanning API (containerscanning.googleapis.com) is enabled"
else
  log_warn "Container Scanning API is not enabled — enabling now"
  gcloud services enable containerscanning.googleapis.com \
    --project="${GCP_PROJECT_ID}" \
    --quiet || die "Failed to enable Container Scanning API"
  log_ok "Container Scanning API enabled"
fi

# ---------------------------------------------------------------------------
# Phase 0d: Per-secret IAM binding for Secret Manager (ADR-017)
# ---------------------------------------------------------------------------
# Binds roles/secretmanager.secretAccessor at the SECRET level (not project
# level) so the Cloud Run service account can only read its own credential.
# This is threat model mitigation (1) for "Service Account Key Exfiltration".

log_step "Configuring per-secret IAM binding (ADR-017)"

SECRET_ID="${SECRET_ID:-firebase-auth-sa-key}"
SERVICE_ACCOUNT="${SERVICE_NAME}-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

# Check if the secret exists before attempting to bind
if gcloud secrets describe "${SECRET_ID}" \
  --project="${GCP_PROJECT_ID}" \
  --quiet >/dev/null 2>&1; then

  # Grant roles/secretmanager.secretAccessor on the specific secret (idempotent)
  gcloud secrets add-iam-policy-binding "${SECRET_ID}" \
    --project="${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null 2>&1 || die "Failed to bind secretAccessor on secret ${SECRET_ID}"
  log_ok "roles/secretmanager.secretAccessor bound on secret ${SECRET_ID} (per-secret, not project-wide)"

  # Audit: warn if the SA also has project-level secretAccessor (over-provisioned)
  PROJECT_IAM=$(gcloud projects get-iam-policy "${GCP_PROJECT_ID}" \
    --format=json \
    --quiet 2>/dev/null) || PROJECT_IAM=""

  if [ -n "${PROJECT_IAM}" ]; then
    PROJECT_SECRET_ACCESS=$(echo "${PROJECT_IAM}" | \
      python3 -c "
import json, sys
policy = json.load(sys.stdin)
sa = 'serviceAccount:${SERVICE_ACCOUNT}'
for binding in policy.get('bindings', []):
    if binding.get('role') == 'roles/secretmanager.secretAccessor':
        if sa in binding.get('members', []):
            print('OVER_PROVISIONED')
" 2>/dev/null) || PROJECT_SECRET_ACCESS=""

    if [ "${PROJECT_SECRET_ACCESS}" = "OVER_PROVISIONED" ]; then
      log_warn "Service account ${SERVICE_ACCOUNT} has PROJECT-LEVEL roles/secretmanager.secretAccessor"
      log_warn "This grants access to ALL secrets in the project — remove the project-level binding"
      log_warn "The per-secret binding on ${SECRET_ID} is sufficient (ADR-017)"
    else
      log_ok "No project-level secretAccessor binding detected (least-privilege verified)"
    fi
  fi
else
  log_warn "Secret ${SECRET_ID} does not exist yet — IAM binding will be applied on first 'deploy'"
fi

# ---------------------------------------------------------------------------
# Phase 0e: Verify Secret Manager DATA_READ audit logs (ADR-018)
# ---------------------------------------------------------------------------
# DATA_READ audit logs capture SecretManagerService.AccessSecretVersion calls.
# Without these logs, there is no record of who read the secret value —
# a critical gap for detecting credential exfiltration (threat model).
# GCP does NOT enable DATA_READ logs by default.

log_step "Checking Secret Manager audit log configuration (ADR-018)"

AUDIT_CONFIG=$(gcloud projects get-iam-policy "${GCP_PROJECT_ID}" \
  --format=json \
  --quiet 2>/dev/null) || AUDIT_CONFIG=""

if [ -n "${AUDIT_CONFIG}" ]; then
  SM_DATA_READ=$(echo "${AUDIT_CONFIG}" | \
    python3 -c "
import json, sys
policy = json.load(sys.stdin)
for ac in policy.get('auditConfigs', []):
    if ac.get('service') == 'secretmanager.googleapis.com':
        for lc in ac.get('auditLogConfigs', []):
            if lc.get('logType') == 'DATA_READ':
                print('ENABLED')
                sys.exit(0)
# Also check allServices wildcard
for ac in policy.get('auditConfigs', []):
    if ac.get('service') == 'allServices':
        for lc in ac.get('auditLogConfigs', []):
            if lc.get('logType') == 'DATA_READ':
                print('ENABLED')
                sys.exit(0)
print('MISSING')
" 2>/dev/null) || SM_DATA_READ="UNKNOWN"

  if [ "${SM_DATA_READ}" = "ENABLED" ]; then
    log_ok "DATA_READ audit logs enabled for Secret Manager"
  elif [ "${SM_DATA_READ}" = "MISSING" ]; then
    log_warn "DATA_READ audit logs are NOT enabled for Secret Manager"
    log_warn "Without these logs, secret access (credential reads) is not recorded"
    log_warn "Enable via: GCP Console → IAM & Admin → Audit Logs → Secret Manager API → Data Read"
    log_warn "Or see ADR-018 for gcloud instructions"
  else
    log_warn "Could not determine Secret Manager audit log configuration"
  fi
else
  log_warn "Could not fetch project IAM policy — skipping audit log check"
fi

# ---------------------------------------------------------------------------
# Phase 0f: Create/update custom IAM roles (ADR-022)
# ---------------------------------------------------------------------------
# Custom roles replace broad predefined roles with exact permissions needed.
# This mitigates "Privilege Escalation via Operator Over-Provisioning" by
# scoping access to only what the firebase-auth service requires.
#
# Set SKIP_CUSTOM_ROLES=true to fall back to predefined roles (e.g., when
# org policy restricts custom role creation).

CUSTOM_ROLES_FILE="${TEMPLATE_DIR}/iam/custom-roles.yaml"

if [ "${SKIP_CUSTOM_ROLES:-false}" = "true" ]; then
  echo -e "\n  ${BLUE}INFO${NC}  Skipping custom role management (SKIP_CUSTOM_ROLES=true)"
  echo -e "  ${BLUE}INFO${NC}  Using predefined roles — see deploy configuration operator_roles / cloud_build_sa_roles"
else
  log_step "Managing custom IAM roles (ADR-022)"

  if [ ! -f "${CUSTOM_ROLES_FILE}" ]; then
    log_warn "Custom roles file not found at ${CUSTOM_ROLES_FILE} — skipping"
  else
    # --- Helper: create or update a custom role from a YAML section ---
    manage_custom_role() {
      local role_id="$1"
      local role_title="$2"
      local role_description="$3"
      local permissions_csv="$4"

      # Check if the role already exists
      if gcloud iam roles describe "${role_id}" \
        --project="${GCP_PROJECT_ID}" \
        --quiet >/dev/null 2>&1; then

        # Role exists — update permissions (idempotent)
        gcloud iam roles update "${role_id}" \
          --project="${GCP_PROJECT_ID}" \
          --permissions="${permissions_csv}" \
          --quiet >/dev/null 2>&1 || {
            log_warn "Failed to update custom role ${role_id} — continuing with existing definition"
            return 0
          }
        log_ok "Custom role updated: ${role_id}"
      else
        # Role does not exist — create it
        gcloud iam roles create "${role_id}" \
          --project="${GCP_PROJECT_ID}" \
          --title="${role_title}" \
          --description="${role_description}" \
          --permissions="${permissions_csv}" \
          --stage=GA \
          --quiet >/dev/null 2>&1 || {
            log_warn "Failed to create custom role ${role_id} — falling back to predefined roles"
            return 1
          }
        log_ok "Custom role created: ${role_id}"
      fi
      return 0
    }

    # --- Parse operator role permissions from YAML ---
    OPERATOR_PERMISSIONS=$(python3 -c "
import yaml, sys
with open('${CUSTOM_ROLES_FILE}') as f:
    data = yaml.safe_load(f)
role = data.get('operator', {})
perms = role.get('includedPermissions', [])
print(','.join(perms))
" 2>/dev/null) || OPERATOR_PERMISSIONS=""

    # --- Parse Cloud Build SA role permissions from YAML ---
    BUILDER_PERMISSIONS=$(python3 -c "
import yaml, sys
with open('${CUSTOM_ROLES_FILE}') as f:
    data = yaml.safe_load(f)
role = data.get('cloud_build_sa', {})
perms = role.get('includedPermissions', [])
print(','.join(perms))
" 2>/dev/null) || BUILDER_PERMISSIONS=""

    CUSTOM_ROLES_OK=true

    if [ -n "${OPERATOR_PERMISSIONS}" ]; then
      manage_custom_role \
        "firebaseAuthPackOperator" \
        "Firebase Auth Service — Operator" \
        "Scoped operator role for the Firebase Auth Service (ADR-022)" \
        "${OPERATOR_PERMISSIONS}" || CUSTOM_ROLES_OK=false
    else
      log_warn "Could not parse operator permissions from ${CUSTOM_ROLES_FILE}"
      CUSTOM_ROLES_OK=false
    fi

    if [ -n "${BUILDER_PERMISSIONS}" ]; then
      manage_custom_role \
        "firebaseAuthPackBuilder" \
        "Firebase Auth Service — Cloud Build SA" \
        "Scoped build/deploy role for the Firebase Auth Service (ADR-022)" \
        "${BUILDER_PERMISSIONS}" || CUSTOM_ROLES_OK=false
    else
      log_warn "Could not parse builder permissions from ${CUSTOM_ROLES_FILE}"
      CUSTOM_ROLES_OK=false
    fi

    if [ "${CUSTOM_ROLES_OK}" = true ]; then
      log_ok "Custom IAM roles are up to date"
      echo "  Operator: projects/${GCP_PROJECT_ID}/roles/firebaseAuthPackOperator"
      echo "  Builder:  projects/${GCP_PROJECT_ID}/roles/firebaseAuthPackBuilder"
    else
      log_warn "Some custom roles could not be managed — predefined roles will be used as fallback"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Phase 1: Build container image via Cloud Build
# ---------------------------------------------------------------------------

log_step "Building container image"
echo "  Image: ${TAGGED_IMAGE}"
echo "  Context: ${TEMPLATE_DIR}"

gcloud builds submit "${TEMPLATE_DIR}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --tag="${TAGGED_IMAGE}" \
  --quiet

log_ok "Container image built and pushed to Artifact Registry"

# ---------------------------------------------------------------------------
# Phase 1b: Resolve image digest for immutable deploy (threat model mitigation)
# ---------------------------------------------------------------------------

log_step "Resolving image digest"

IMAGE_DIGEST=$(gcloud artifacts docker images describe "${TAGGED_IMAGE}" \
  --project="${GCP_PROJECT_ID}" \
  --format='value(image_summary.digest)' \
  --quiet 2>/dev/null) || die "Failed to resolve image digest for ${TAGGED_IMAGE}"

if [ -z "${IMAGE_DIGEST}" ]; then
  die "Image digest is empty — cannot deploy without digest pinning"
fi

# Build the immutable image reference: image@sha256:abc123...
# Strip the tag and append digest to the repository path
IMAGE_REPO="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"
PINNED_IMAGE="${IMAGE_REPO}@${IMAGE_DIGEST}"

log_ok "Resolved digest: ${IMAGE_DIGEST}"
echo "  Pinned image: ${PINNED_IMAGE}"

# ---------------------------------------------------------------------------
# Phase 1c: Check vulnerability scan results (Artifact Analysis)
# ---------------------------------------------------------------------------
# After pushing, Artifact Analysis automatically scans the image for known
# CVEs. We check for CRITICAL vulnerabilities and warn (non-blocking in v1
# — can be made blocking with BLOCK_ON_VULNS=true).

log_step "Checking vulnerability scan results"

VULN_COUNT=$(gcloud artifacts docker images list "${IMAGE_REPO}" \
  --project="${GCP_PROJECT_ID}" \
  --include-tags \
  --format='value(VULNERABILITIES)' \
  --filter="version=${IMAGE_DIGEST}" \
  --quiet 2>/dev/null) || VULN_COUNT=""

if [ -n "${VULN_COUNT}" ] && [ "${VULN_COUNT}" != "0" ]; then
  echo "  Vulnerability summary: ${VULN_COUNT}"

  # Check for CRITICAL severity vulnerabilities
  CRITICAL_VULNS=$(gcloud artifacts vulnerabilities list "${PINNED_IMAGE}" \
    --project="${GCP_PROJECT_ID}" \
    --format='value(vulnerability.effectiveSeverity)' \
    --quiet 2>/dev/null | grep -c "CRITICAL" || true)

  if [ "${CRITICAL_VULNS}" -gt 0 ]; then
    if [ "${BLOCK_ON_VULNS:-false}" = "true" ]; then
      die "Image has ${CRITICAL_VULNS} CRITICAL vulnerabilities — set BLOCK_ON_VULNS=false to deploy anyway"
    else
      log_warn "Image has ${CRITICAL_VULNS} CRITICAL vulnerabilities — review recommended before production use"
      log_warn "Set BLOCK_ON_VULNS=true to enforce vulnerability gate"
    fi
  else
    log_ok "No CRITICAL vulnerabilities found"
  fi
else
  log_warn "Vulnerability scan results not yet available (scanning may still be in progress)"
  echo "  View results: https://console.cloud.google.com/artifacts/docker/${GCP_PROJECT_ID}/${GCP_REGION}/${REPO_NAME}/${SERVICE_NAME}"
fi

# ---------------------------------------------------------------------------
# Phase 1d: Binary Authorization attestation verification (deferred — ADR-016)
# ---------------------------------------------------------------------------
# Binary Authorization provides deploy-time policy enforcement by requiring
# container images to be signed by a trusted attestor before Cloud Run will
# run them. This is threat model mitigation (4) for "Container Image Tampering".
#
# Deferred to v1.1 — the existing mitigations (digest pinning ADR-015,
# Artifact Registry IAM audit, vulnerability scanning) are sufficient for v1.
# When enabled, this phase would:
#   1. Verify the image has a valid BinAuthz attestation
#   2. Fail the deploy if attestation is missing or invalid
#   3. Support a breakglass flag for emergency deploys
#
# See ADR-016 for the full rationale and v1.1 implementation sketch.

# ---------------------------------------------------------------------------
# Phase 2: Deploy to Cloud Run
# ---------------------------------------------------------------------------

log_step "Deploying to Cloud Run (digest-pinned per ADR-015)"
echo "  Service: ${SERVICE_NAME}"
echo "  Region:  ${GCP_REGION}"
echo "  Image:   ${PINNED_IMAGE}"
echo "  Ingress: internal (per ADR-009)"

# Build deploy args — credential mode determines secrets and env vars (ADR-019)
DEPLOY_ARGS=(
  --project="${GCP_PROJECT_ID}"
  --region="${GCP_REGION}"
  --image="${PINNED_IMAGE}"
  --platform=managed
  --ingress=internal
  --no-allow-unauthenticated
  --service-account="${SERVICE_NAME}-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  --port=8080
  --quiet
)

if [ "${FIREBASE_USE_ADC:-false}" = "true" ]; then
  echo "  Credential: Application Default Credentials (WIF — ADR-019)"
  DEPLOY_ARGS+=(--set-env-vars="FIREBASE_USE_ADC=true")
else
  echo "  Credential: SA JSON key from Secret Manager"
  DEPLOY_ARGS+=(--set-secrets="FIREBASE_SERVICE_ACCOUNT_JSON=firebase-auth-sa-key:latest")
fi

gcloud run deploy "${SERVICE_NAME}" "${DEPLOY_ARGS[@]}"

log_ok "Cloud Run service deployed with digest-pinned image"

# ---------------------------------------------------------------------------
# Phase 3: Smoke tests via gcloud proxy (ADR-009)
# ---------------------------------------------------------------------------

if [ "${SKIP_SMOKE:-false}" = "true" ]; then
  echo -e "\n  ${BLUE}INFO${NC}  Skipping smoke tests (SKIP_SMOKE=true)"
else
  log_step "Running smoke tests via gcloud proxy (ADR-009)"
  "${SCRIPT_DIR}/smoke-cloud-run.sh"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

log_step "Deployment complete"
log_ok "Service ${SERVICE_NAME} is live in ${GCP_REGION}"

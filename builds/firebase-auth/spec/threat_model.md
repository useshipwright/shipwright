# Threat Model — PRD — Firebase Auth Verification Service

## Attack Surface

- **Cloud Run HTTPS Endpoint**: Primary ingress point. Protected by internal-only ingress and Cloud Run IAM (OIDC). Application receives only authenticated, internal-origin requests. Exposes /health, /verify, /batch-verify, /user-lookup/:uid.

- **Firebase Admin SDK Outbound (HTTPS)**: Outbound calls to Google APIs: public key endpoint for JWKS (unauthenticated), Identity Toolkit API for getUser() and checkRevoked (authenticated with SA credentials). MITM risk mitigated by TLS and certificate pinning in SDK.

- **GCP Secret Manager (Startup)**: FIREBASE_SERVICE_ACCOUNT_JSON mounted as env var via --set-secrets at revision creation time. Secret value exists in container memory for the process lifetime. Not accessible via /proc in Cloud Run (gVisor sandbox).

- **Container Image (Artifact Registry)**: Built image stored in Artifact Registry. If image contains secrets baked in at build time, they are permanently exposed. Multi-stage Dockerfile with runtime-only stage mitigates this.

- **Cloud Build Logs**: Build logs may capture environment variables, build arguments, or error messages containing sensitive data. Accessible to anyone with roles/cloudbuild.builds.viewer.

- **Request Body (Token Input)**: Callers send Firebase ID tokens in POST body. Tokens are bearer credentials — if intercepted, they grant identity impersonation for up to 1 hour. TLS in transit mitigates.


## Identified Threats

| Threat | Category | Likelihood | Impact | Mitigation |
|--------|----------|------------|--------|------------|
| Token Replay Attack | auth | medium | high | Firebase ID tokens are valid for 1 hour and not bound to a specific caller IP. Mitigation: (1) internal-only ingress limits network exposure, (2) Cloud Run IAM ensures only authorized services can call the endpoint, (3) consider checkRevoked=true for sensitive operations (adds latency but checks revocation list). v1 does NOT use checkRevoked by default — document this limitation.
 |
| Batch Endpoint Abuse (Resource Exhaustion) | auth | medium | medium | Batch endpoint accepts up to 25 tokens. Each triggers a verifyIdToken() call (CPU-bound crypto). An authorized caller could send rapid batch requests to exhaust CPU. Mitigation: (1) 25-token limit is enforced, (2) rate limiting is deferred to v1.1 — this is a known gap, (3) Cloud Run concurrency and max-instances provide some protection, (4) monitor batch request volume in logs.
 |
| Information Leakage via Error Responses | exposure | low | medium | PRD requires generic 401 for single verify (REQ-008). However, batch-verify returns per-token error categories (expired|invalid| malformed per ADR-002). An attacker with service-to-service access could use batch-verify to probe token states. Mitigation: (1) batch-verify is behind Cloud Run IAM, (2) error categories are coarse (3 buckets only), (3) document the intentional inconsistency between verify and batch-verify error granularity.
 |
| Credential Exposure in Logs | exposure | medium | high | FIREBASE_SERVICE_ACCOUNT_JSON contains a private key. If logged (e.g., during init error, uncaught exception serialization, or debug logging), it could be retrieved from Cloud Logging. Mitigation: (1) Pino redaction serializers strip JWT patterns, SA JSON patterns, and bearer tokens (REQ-007), (2) adapter pattern isolates credential to single module, (3) fail-fast on init prevents credential from propagating to request context, (4) MUST verify redaction covers Pino's err serializer for uncaught exceptions.
 |
| JWT Structure Bypass | injection | low | medium | validate-jwt.ts pre-validates 3-part base64url structure before passing to Firebase SDK. If validation is too permissive (e.g., allows non-base64url characters), malformed input could reach the SDK. Mitigation: (1) strict regex for base64url characters, (2) Firebase SDK performs its own validation as defense-in-depth, (3) input length limits to prevent memory abuse from extremely long token strings.
 |
| Timing Side-Channel on Token Verification | auth | low | low | ADR-010 specifies constant-time response timing normalization on the verify endpoint. Without this, an attacker could distinguish between "malformed token" (fast reject at validation) and "valid structure, bad signature" (slower crypto operation). Mitigation: (1) add artificial delay to normalize response times for error cases, (2) note that the Firebase SDK's verifyIdToken() itself is NOT constant-time (different code paths for different errors).
 |
| Denial of Service via Large Request Bodies | injection | medium | medium | Without request body size limits, an attacker could send multi-MB request bodies to exhaust memory. Mitigation: (1) Fastify has default body size limit (1MB), (2) JSON schema validation rejects non-conforming payloads early, (3) batch-verify enforces max 25 tokens, (4) consider explicit --max-request-size in Fastify config.
 |
| SSRF via User-Lookup UID Parameter | csrf | low | low | The UID parameter in GET /user-lookup/:uid is passed to Firebase's getUser(). Firebase SDK sends it to the Identity Toolkit API. The UID is validated (non-empty, ≤128 chars, alphanumeric-ish) before SDK call. No SSRF risk because the UID is used as a lookup key, not a URL. However, malicious UIDs could trigger unexpected SDK behavior. Mitigation: strict input validation regex.
 |
| Container Image Tampering | misconfig | low | high | If Artifact Registry permissions are too broad, an attacker could replace the container image with a malicious one. Mitigation: (1) use image digest pinning in Cloud Run deploy, (2) restrict roles/artifactregistry.writer to Cloud Build SA only, (3) enable Artifact Analysis for vulnerability scanning, (4) consider Binary Authorization for deploy-time verification.
 |
| Service Account Key Exfiltration | access | low | high | FIREBASE_SERVICE_ACCOUNT_JSON is a long-lived credential. If exfiltrated from Secret Manager or container memory, an attacker gains persistent Firebase Admin access. Mitigation: (1) per-secret IAM binding (not project-wide), (2) Secret Manager audit logging, (3) consider Workload Identity Federation instead of SA key for v1.1, (4) rotate SA key periodically, (5) gVisor sandbox in Cloud Run prevents /proc-based memory scraping.
 |
| Privilege Escalation via Operator Over-Provisioning | access | medium | high | Operator requires 5 powerful roles including resourcemanager.projectIamAdmin and iam.serviceAccountAdmin. A compromised operator account could escalate privileges across the entire GCP project. Mitigation: (1) use short-lived credentials (gcloud auth), (2) require MFA on operator accounts, (3) consider custom roles with narrower permissions instead of predefined roles, (4) permission diff approval step provides audit trail.
 |
| passwordHash/passwordSalt Exposure in User-Lookup Response | exposure | medium | high | Firebase UserRecord may include passwordHash and passwordSalt if the SA has elevated permissions. These MUST be stripped from the user-lookup API response. The current architecture does not explicitly mention field filtering on UserRecord. Mitigation: (1) explicitly allowlist fields returned from user-lookup (do NOT spread the full UserRecord), (2) add test to verify passwordHash is never in response.
 |
| Stale JWKS Cache After Key Rotation | auth | low | medium | Firebase SDK caches public keys in memory with Cache-Control TTL (~6 hours). During key rotation, tokens signed with new keys will fail verification until cache refreshes. The SDK does NOT retry with refreshed keys on NO_MATCHING_KID error. Mitigation: (1) accept brief verification failures during rotation (documented SDK behavior), (2) Cloud Run auto-scales new instances which start with fresh cache, (3) monitor for spikes in auth/invalid-id-token errors.
 |

## Mitigation Details

### Token Replay Attack

Firebase ID tokens are valid for 1 hour and not bound to a specific caller IP. Mitigation: (1) internal-only ingress limits network exposure, (2) Cloud Run IAM ensures only authorized services can call the endpoint, (3) consider checkRevoked=true for sensitive operations (adds latency but checks revocation list). v1 does NOT use checkRevoked by default — document this limitation.


### Batch Endpoint Abuse (Resource Exhaustion)

Batch endpoint accepts up to 25 tokens. Each triggers a verifyIdToken() call (CPU-bound crypto). An authorized caller could send rapid batch requests to exhaust CPU. Mitigation: (1) 25-token limit is enforced, (2) rate limiting is deferred to v1.1 — this is a known gap, (3) Cloud Run concurrency and max-instances provide some protection, (4) monitor batch request volume in logs.


### Information Leakage via Error Responses

PRD requires generic 401 for single verify (REQ-008). However, batch-verify returns per-token error categories (expired|invalid| malformed per ADR-002). An attacker with service-to-service access could use batch-verify to probe token states. Mitigation: (1) batch-verify is behind Cloud Run IAM, (2) error categories are coarse (3 buckets only), (3) document the intentional inconsistency between verify and batch-verify error granularity.


### Credential Exposure in Logs

FIREBASE_SERVICE_ACCOUNT_JSON contains a private key. If logged (e.g., during init error, uncaught exception serialization, or debug logging), it could be retrieved from Cloud Logging. Mitigation: (1) Pino redaction serializers strip JWT patterns, SA JSON patterns, and bearer tokens (REQ-007), (2) adapter pattern isolates credential to single module, (3) fail-fast on init prevents credential from propagating to request context, (4) MUST verify redaction covers Pino's err serializer for uncaught exceptions.


### JWT Structure Bypass

validate-jwt.ts pre-validates 3-part base64url structure before passing to Firebase SDK. If validation is too permissive (e.g., allows non-base64url characters), malformed input could reach the SDK. Mitigation: (1) strict regex for base64url characters, (2) Firebase SDK performs its own validation as defense-in-depth, (3) input length limits to prevent memory abuse from extremely long token strings.


### Timing Side-Channel on Token Verification

ADR-010 specifies constant-time response timing normalization on the verify endpoint. Without this, an attacker could distinguish between "malformed token" (fast reject at validation) and "valid structure, bad signature" (slower crypto operation). Mitigation: (1) add artificial delay to normalize response times for error cases, (2) note that the Firebase SDK's verifyIdToken() itself is NOT constant-time (different code paths for different errors).


### Denial of Service via Large Request Bodies

Without request body size limits, an attacker could send multi-MB request bodies to exhaust memory. Mitigation: (1) Fastify has default body size limit (1MB), (2) JSON schema validation rejects non-conforming payloads early, (3) batch-verify enforces max 25 tokens, (4) consider explicit --max-request-size in Fastify config.


### SSRF via User-Lookup UID Parameter

The UID parameter in GET /user-lookup/:uid is passed to Firebase's getUser(). Firebase SDK sends it to the Identity Toolkit API. The UID is validated (non-empty, ≤128 chars, alphanumeric-ish) before SDK call. No SSRF risk because the UID is used as a lookup key, not a URL. However, malicious UIDs could trigger unexpected SDK behavior. Mitigation: strict input validation regex.


### Container Image Tampering

If Artifact Registry permissions are too broad, an attacker could replace the container image with a malicious one. Mitigation: (1) use image digest pinning in Cloud Run deploy, (2) restrict roles/artifactregistry.writer to Cloud Build SA only, (3) enable Artifact Analysis for vulnerability scanning, (4) consider Binary Authorization for deploy-time verification.


### Service Account Key Exfiltration

FIREBASE_SERVICE_ACCOUNT_JSON is a long-lived credential. If exfiltrated from Secret Manager or container memory, an attacker gains persistent Firebase Admin access. Mitigation: (1) per-secret IAM binding (not project-wide), (2) Secret Manager audit logging, (3) consider Workload Identity Federation instead of SA key for v1.1, (4) rotate SA key periodically, (5) gVisor sandbox in Cloud Run prevents /proc-based memory scraping.


### Privilege Escalation via Operator Over-Provisioning

Operator requires 5 powerful roles including resourcemanager.projectIamAdmin and iam.serviceAccountAdmin. A compromised operator account could escalate privileges across the entire GCP project. Mitigation: (1) use short-lived credentials (gcloud auth), (2) require MFA on operator accounts, (3) consider custom roles with narrower permissions instead of predefined roles, (4) permission diff approval step provides audit trail.


### passwordHash/passwordSalt Exposure in User-Lookup Response

Firebase UserRecord may include passwordHash and passwordSalt if the SA has elevated permissions. These MUST be stripped from the user-lookup API response. The current architecture does not explicitly mention field filtering on UserRecord. Mitigation: (1) explicitly allowlist fields returned from user-lookup (do NOT spread the full UserRecord), (2) add test to verify passwordHash is never in response.


### Stale JWKS Cache After Key Rotation

Firebase SDK caches public keys in memory with Cache-Control TTL (~6 hours). During key rotation, tokens signed with new keys will fail verification until cache refreshes. The SDK does NOT retry with refreshed keys on NO_MATCHING_KID error. Mitigation: (1) accept brief verification failures during rotation (documented SDK behavior), (2) Cloud Run auto-scales new instances which start with fresh cache, (3) monitor for spikes in auth/invalid-id-token errors.


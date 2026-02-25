# PRD — Firebase Auth Verification Service v1

Owner: Luke
Last updated: 2026-02-15
Status: Draft (ready for build)

---

## 1) Summary

Build a standalone **Firebase Authentication verification microservice** on **GCP Cloud Run**, backed by **Firebase Authentication (Identity Platform)**. The service verifies Firebase ID tokens, exposes user identity to internal systems, and provides a token introspection API.

Goal: run one command and get a working auth verification service that other microservices call to validate user identity. Verify token, get claims, look up users.

---

## 2) Goals

- Provide a **service-to-service auth verification gateway**:
  - Verify Firebase-issued ID tokens with full claim extraction
  - Batch-verify multiple tokens in a single call (max 25)
  - Look up user profiles by UID via Firebase Admin SDK
  - Cache Firebase public keys (JWKS) with auto-refresh
- Standardise enterprise baseline:
  - Secure defaults (no secrets in logs, least privilege, internal-only by default)
  - Constant-time operations where security-relevant

---

## 3) Non-Goals (v1)

- Multi-cloud support
- Database provisioning (no user DB; rely on Firebase for identities)
- UI / frontend auth screens
- OAuth provider setup automation (Google/Apple/GitHub)
- Multi-tenant org model (single tenant per deployment)
- Custom domains / SSL management
- Full RBAC/ABAC policy engine (token verification only)
- Custom token minting (v1.1)
- Session management / server-side sessions
- Rate limiting (v1.1)

---

## 4) Target Environment

- Deploy target: **GCP Cloud Run**
- Secrets: **GCP Secret Manager**
- Build: **Cloud Build** (container build)
- Runtime: **TypeScript (Node 22)**, package manager **pnpm**
- Framework: **Fastify**

---

## 5) Capabilities

- **Verify**: verify a single Firebase ID token, returning uid, email, custom claims, and token metadata
- **Batch verify**: verify up to 25 tokens in a single call, returning per-token results (valid/invalid with reason)
- **User lookup**: look up a user profile by UID via Firebase Admin SDK (email, display name, provider data, custom claims, disabled status)
- **Health**: health check endpoint

**Integration points**:
- All routes are internal (other microservices). Default `allow_unauthenticated=false`.
- Calling services obtain Firebase ID tokens from client-side Firebase Auth SDK, then call this service to verify them server-side.

---

## 6) Required Secrets

- `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase Admin SDK service account JSON credential. Used to initialise the Firebase Admin SDK for token verification and user lookups.

---

## 7) Security Principles

- **Verify all tokens fully**: every call must verify the JWT signature, expiry, issuer, and audience. Never trust claims without verification.
- **No secrets in logs**: redactor must apply to all log output. User emails and UIDs must be partially redacted in logs.
- **Secret isolation**: the `FIREBASE_SERVICE_ACCOUNT_JSON` must only be used in the Firebase SDK initialisation module. Never passed to route handlers.
- **Default ingress**: internal-only. This service is called by other microservices, not end users.
- **Generic error responses**: token verification errors return generic 401. Do not distinguish between "expired", "bad signature", "wrong audience" in the HTTP response. Log the detail server-side.
- **Input validation**: validate all inbound data at system boundaries. Validate token format (JWT structure) before passing to Firebase SDK.

---

## 8) IAM Requirements

**Operator** (human deploying the service):
- `roles/run.admin`
- `roles/cloudbuild.builds.editor`
- `roles/secretmanager.admin`
- `roles/iam.serviceAccountAdmin`
- `roles/resourcemanager.projectIamAdmin`

**Service account** (runtime identity):
- `roles/secretmanager.secretAccessor` (to read FIREBASE_SERVICE_ACCOUNT_JSON)
- `roles/logging.logWriter` (Cloud Run default logging)

---

## 9) Verification (Smoke Tests)

Success criteria — deployment is only "SUCCESS" if:
- Health endpoint responds
- Valid Firebase ID token is verified and returns correct claims
- Expired/invalid token is correctly rejected with 401
- Missing request body is rejected with 400

---

## 10) Observability

- Structured JSON logs for: verification requests (result, uid if valid, latency), Firebase Admin API calls, user lookups
- Request correlation ID on all endpoints
- Log rejected tokens with reason (expired, bad signature, malformed) — server-side only
- Log batch verification summary (total, valid count, invalid count)
- Log Firebase SDK initialisation status at startup

---

## 11) Future Enhancements (v1.1+)

- Custom token minting endpoint
- JWKS/certs proxy with caching
- Rate limiting per calling service
- Token revocation checking (Firebase revocation list)
- Multi-environment support (dev/stage/prod)
- Session token minting for service-to-service auth
- Claims-based authorization middleware

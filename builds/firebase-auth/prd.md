# PRD — Firebase Auth Pack v1.1

Owner: Luke
Last updated: 2026-02-27
Status: Draft (ready for build)

---

## 1) Summary

Build a **deployable Pack** that provisions and deploys a standalone **Firebase Authentication microservice** on **GCP Cloud Run**, backed by **Firebase Authentication (Identity Platform)**. The service exposes the full Firebase Admin Auth SDK surface — token verification, user management, custom claims, session cookies, custom tokens, email action links, and batch operations — as a service-to-service REST API.

v1 scored 45/47 (Grade A) with 4 capabilities. v1.1 expands to 9 capabilities (~22 endpoints), covering the complete Firebase Admin SDK auth surface. This is the stress test: maintain Grade A quality at 3x the complexity.

---

## 2) Goals

- Expose the **full Firebase Admin Auth SDK** as a REST API:
  - Token verification with revocation checking
  - User CRUD (create, read, update, delete, disable, enable)
  - User lookup by UID, email, phone number, and batch
  - Custom claims management (set, delete)
  - Session cookie creation and verification
  - Custom token minting
  - Token revocation
  - Email action link generation (password reset, email verification, sign-in)
  - Batch operations (bulk delete, paginated list)
  - Health with version and uptime metadata
- **API key authentication** on all endpoints (except /health) via `X-API-Key` header
- **Rate limiting** per operation class: read (200/min), mutation (50/min), batch (20/min)
- **Audit logging** for all mutation operations
- **Prometheus metrics** at `/metrics`
- **Graceful shutdown** with 10s drain timeout
- Maintain enterprise baseline from v1: atomic deploys, secret redaction, evidence bundles

---

## 3) Non-Goals (v1.1)

- Multi-tenancy (Identity Platform tenant isolation) — deferred to v2.0
- MFA enrollment management — deferred to v2.0
- OIDC/SAML provider configuration — deferred to v2.0
- User import with password hashes (`importUsers`) — deferred to v2.0
- Project-level auth configuration — deferred to v2.0
- Multi-cloud support
- UI / frontend auth screens
- OAuth provider setup automation
- Custom domains / SSL management
- Full RBAC/ABAC policy engine

---

## 4) Target Environment

- Deploy target: **GCP Cloud Run**
- Secrets: **GCP Secret Manager**
- Build: **Cloud Build** (container build)
- Runtime: **TypeScript (Node 22)**, package manager **pnpm**
- Framework: **Fastify**

---

## 5) Primary User / Operator Story

As an operator, I want to run:

```bash
orchestrator pack apply firebase-auth \
  --gcp-project <project-id> \
  --region <region> \
  --secret-from-env "FIREBASE_SERVICE_ACCOUNT_JSON=FIREBASE_SA_JSON"
```

and receive:
- a deployed URL with all 22 auth endpoints operational
- smoke test pass status
- evidence bundle paths
- an integration snippet for calling services

---

## 6) Capabilities

Pack ID: `firebase-auth`

### CAP-1: Token Verification

Verify Firebase ID tokens with full claim extraction and optional revocation checking.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/verify` | Verify a single Firebase ID token. Optional `checkRevoked: true` to reject revoked tokens. Returns uid, email, custom claims, token metadata. |
| POST | `/batch-verify` | Verify up to 25 tokens in a single call. Each token can independently opt into `checkRevoked`. Returns per-token results (valid/invalid with reason). |

**Firebase Admin SDK methods:** `verifyIdToken(token, checkRevoked?)`

### CAP-2: User Lookup

Look up user profiles by various identifiers.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/users/:uid` | Look up a user by UID. Returns email, displayName, phoneNumber, photoURL, providerData, customClaims, disabled, metadata (creationTime, lastSignInTime, lastRefreshTime). |
| GET | `/users/by-email/:email` | Look up a user by email address. Returns same profile shape as UID lookup. |
| GET | `/users/by-phone/:phoneNumber` | Look up a user by phone number (E.164 format). Returns same profile shape as UID lookup. |
| POST | `/users/batch` | Look up up to 100 users by mixed identifiers (uid, email, phone). Returns found users and list of not-found identifiers. |

**Firebase Admin SDK methods:** `getUser(uid)`, `getUserByEmail(email)`, `getUserByPhoneNumber(phone)`, `getUsers(identifiers[])`

### CAP-3: User Management

Create, update, delete, disable, and enable user accounts.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/users` | Create a new user. Accepts email, password, displayName, phoneNumber, photoURL, disabled, emailVerified. Returns the created user record. |
| PATCH | `/users/:uid` | Update an existing user. Accepts any combination of email, password, displayName, phoneNumber, photoURL, disabled, emailVerified. Returns the updated user record. |
| DELETE | `/users/:uid` | Delete a user by UID. Returns 204 on success. |
| POST | `/users/:uid/disable` | Disable a user account (sets `disabled: true`). Returns updated user record. |
| POST | `/users/:uid/enable` | Enable a user account (sets `disabled: false`). Returns updated user record. |

**Firebase Admin SDK methods:** `createUser(properties)`, `updateUser(uid, properties)`, `deleteUser(uid)`

### CAP-4: Custom Claims

Set and delete custom claims on user accounts. Custom claims propagate to ID tokens on next refresh.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/users/:uid/claims` | Set custom claims on a user. Body: `{ claims: { role: "admin", ... } }`. Maximum 1000 bytes serialized. Returns 200 with the set claims. |
| DELETE | `/users/:uid/claims` | Remove all custom claims from a user (sets claims to `{}`). Returns 204. |

**Firebase Admin SDK methods:** `setCustomUserClaims(uid, claims)`

### CAP-5: Session Cookies

Create and verify session cookies for server-side session management.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create a session cookie from a Firebase ID token. Body: `{ idToken, expiresIn }`. `expiresIn` in milliseconds (min 5 minutes, max 14 days). Returns the session cookie string. |
| POST | `/sessions/verify` | Verify a session cookie. Body: `{ sessionCookie, checkRevoked? }`. Returns decoded claims on success. |

**Firebase Admin SDK methods:** `createSessionCookie(idToken, { expiresIn })`, `verifySessionCookie(cookie, checkRevoked?)`

### CAP-6: Token Operations

Mint custom tokens and revoke refresh tokens.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/tokens/custom` | Create a custom token for a given UID with optional additional claims. Body: `{ uid, claims? }`. Returns the signed custom token. |
| POST | `/users/:uid/revoke` | Revoke all refresh tokens for a user. Forces re-authentication on next token refresh. Returns 200 with `tokensValidAfterTime`. |

**Firebase Admin SDK methods:** `createCustomToken(uid, claims?)`, `revokeRefreshTokens(uid)`

### CAP-7: Email Action Links

Generate email action links for password reset, email verification, and email sign-in.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/email-actions/password-reset` | Generate a password reset link. Body: `{ email, actionCodeSettings? }`. Returns the link URL. |
| POST | `/email-actions/verification` | Generate an email verification link. Body: `{ email, actionCodeSettings? }`. Returns the link URL. |
| POST | `/email-actions/sign-in` | Generate an email sign-in link. Body: `{ email, actionCodeSettings }` (`actionCodeSettings` required with `url` and `handleCodeInApp: true`). Returns the link URL. |

**Firebase Admin SDK methods:** `generatePasswordResetLink(email, settings?)`, `generateEmailVerificationLink(email, settings?)`, `generateSignInWithEmailLink(email, settings)`

### CAP-8: Batch Operations

Bulk delete users and paginated user listing.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/users/batch-delete` | Delete up to 1000 users in a single call. Body: `{ uids: string[] }`. Returns `{ successCount, failureCount, errors[] }`. |
| GET | `/users` | List users with pagination. Query params: `maxResults` (default 100, max 1000), `pageToken` (from previous response). Returns `{ users[], pageToken? }`. |

**Firebase Admin SDK methods:** `deleteUsers(uids[])`, `listUsers(maxResults, pageToken?)`

### CAP-9: Health

Health check with service metadata.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: "ok", version, uptime, firebase: "connected" | "error" }`. No authentication required. |

**Integration points:**
- All routes except `/health` and `/metrics` require API key authentication via `X-API-Key` header.
- Calling services obtain Firebase ID tokens from client-side Firebase Auth SDK, then call this service for server-side operations.

---

## 7) Cross-Cutting Concerns

### 7.1) API Key Authentication

All endpoints except `/health` and `/metrics` require a valid API key in the `X-API-Key` header. The API key is configured via the `API_KEYS` environment variable (comma-separated list of valid keys). Requests without a valid key receive 401.

### 7.2) Rate Limiting

Rate limiting per API key, per operation class:

| Class | Limit | Endpoints |
|-------|-------|-----------|
| read | 200 requests/min | GET endpoints, POST /verify, POST /batch-verify, POST /sessions/verify |
| mutation | 50 requests/min | POST /users, PATCH, DELETE, PUT, POST /disable, POST /enable, POST /revoke, POST /sessions, POST /tokens/custom, POST /email-actions/* |
| batch | 20 requests/min | POST /batch-verify, POST /users/batch, POST /users/batch-delete, GET /users (list) |

When a request hits both `read` and `batch` (e.g., `/batch-verify`), both limits apply. Return 429 with `Retry-After` header when exceeded.

### 7.3) Audit Logging

All mutation operations (create, update, delete, disable, enable, set claims, revoke tokens) produce structured audit log entries:

```json
{
  "event": "user.created",
  "actor": "<api-key-id>",
  "target": "<uid>",
  "timestamp": "ISO-8601",
  "requestId": "<correlation-id>",
  "changes": { "fields": ["email", "displayName"] }
}
```

Audit logs are written to stdout as structured JSON (picked up by Cloud Logging). The `changes` field lists which fields were modified, not the values (no PII in audit trail).

### 7.4) Prometheus Metrics

Expose `/metrics` endpoint (no auth required) with:

- `http_requests_total{method, path, status}` — counter
- `http_request_duration_seconds{method, path}` — histogram
- `firebase_admin_calls_total{method, status}` — counter
- `firebase_admin_call_duration_seconds{method}` — histogram
- `rate_limit_exceeded_total{class}` — counter
- `active_connections` — gauge

### 7.5) Graceful Shutdown

On SIGTERM:
1. Stop accepting new connections
2. Wait up to 10s for in-flight requests to complete
3. Close Firebase Admin SDK connection
4. Exit 0

---

## 8) Required Secrets

- `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase Admin SDK service account JSON credential. Used to initialise the Firebase Admin SDK for all auth operations.

---

## 9) Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes (secret) | — | Service account JSON for Firebase Admin SDK |
| `API_KEYS` | Yes | — | Comma-separated list of valid API keys |
| `PORT` | No | `3000` | HTTP listen port |
| `LOG_LEVEL` | No | `info` | Log level (debug, info, warn, error) |
| `RATE_LIMIT_READ` | No | `200` | Read operations per minute per key |
| `RATE_LIMIT_MUTATION` | No | `50` | Mutation operations per minute per key |
| `RATE_LIMIT_BATCH` | No | `20` | Batch operations per minute per key |
| `SESSION_COOKIE_MAX_AGE` | No | `1209600000` | Max session cookie age in ms (default 14 days) |
| `SHUTDOWN_TIMEOUT` | No | `10000` | Graceful shutdown timeout in ms |
| `NODE_ENV` | No | `production` | Environment (development, production) |
| `CORS_ORIGIN` | No | — | Allowed CORS origin (warn if unset in production) |

---

## 10) Security Principles

- **Verify all tokens fully**: every call must verify JWT signature, expiry, issuer, and audience. Never trust claims without verification.
- **No secrets in logs**: redactor must apply to all log output. User emails and UIDs must be partially redacted in logs.
- **Secret isolation**: `FIREBASE_SERVICE_ACCOUNT_JSON` must only be used in the Firebase SDK initialisation module. Never passed to route handlers.
- **Default ingress**: internal-only. This service is called by other microservices, not end users.
- **Generic error responses**: authentication and authorization errors return generic 401/403 — do not distinguish between error types in the HTTP response. Log details server-side only.
- **Input validation**: validate all inbound data at system boundaries. Validate token format (JWT structure) before passing to Firebase SDK. Validate email format, phone E.164 format, UID length. Validate custom claims payload size (max 1000 bytes).
- **API key security**: constant-time comparison for API key validation. Never log API key values.
- **Custom claims size limit**: enforce Firebase's 1000-byte limit on serialized custom claims before calling the SDK.
- **Password handling**: never log or return password values. Passwords accepted on create/update only.
- **Batch operation limits**: enforce maximum batch sizes (25 for verify, 100 for lookup, 1000 for delete) before calling Firebase SDK.

---

## 11) IAM Requirements

**Operator** (human running `pack apply`):
- `roles/run.admin`
- `roles/cloudbuild.builds.editor`
- `roles/secretmanager.admin`
- `roles/iam.serviceAccountAdmin`
- `roles/resourcemanager.projectIamAdmin`

**Pack service account** (created per pack):
- `roles/secretmanager.secretAccessor` (to read FIREBASE_SERVICE_ACCOUNT_JSON)
- `roles/logging.logWriter` (Cloud Run default logging)
- `roles/firebaseauth.admin` (for full auth admin operations — custom tokens, user management, session cookies)

---

## 12) Preflight (Pack Plan)

```
orchestrator pack plan firebase-auth --gcp-project X
```

Must check:
- active gcloud account and project access
- billing enabled
- required APIs enabled (Cloud Run, Cloud Build, Secret Manager, IAM, Artifact Registry, Identity Toolkit)
- secret existence
- org policy blockers (best-effort)

---

## 13) Apply (Deploy)

```
orchestrator pack apply firebase-auth --gcp-project X ...
```

Must:
1. Execute preflight
2. Generate infra permission diff and require approval
3. Enable missing APIs
4. Create missing secrets from `--secret-from-env` mapping
5. Create/reuse service account and bind IAM roles
6. Build container and deploy Cloud Run service
7. Run auto-smoke tests
8. Write evidence bundle

---

## 14) Verification (Auto-Smoke)

Success criteria — deployment is only "SUCCESS" if:
- Health endpoint responds with `{ status: "ok" }` and includes version and uptime
- Valid Firebase ID token is verified and returns correct claims (provided via `--verify-token-from-env FIREBASE_TEST_ID_TOKEN`)
- Expired/invalid token is correctly rejected with 401
- Missing request body is rejected with 400
- API key authentication rejects requests without `X-API-Key` header with 401
- If test token is not provided, degrade gracefully: health-only pass, mark verify steps as skipped with `--allow-smoke-skip`

---

## 15) Observability

- Structured JSON logs for: all requests (method, path, status, latency), Firebase Admin API calls, user lookups, mutations
- Request correlation ID (`X-Request-ID`) on all endpoints
- Log rejected tokens with reason (expired, bad signature, malformed) — server-side only
- Log batch operation summaries (total, success count, failure count)
- Log Firebase SDK initialisation status at startup
- Audit log entries for all mutations (see §7.3)
- Prometheus metrics (see §7.4)

---

## 16) Evidence & Artifacts

On plan/apply, must write:
- `.ai/runs/<run_id>/events.ndjson`
- `.ai/runs/<run_id>/summary.json`
- `packs/<pack_id>/deploy/inputs.yaml`
- `packs/<pack_id>/deploy/result.yaml`
- `.ai/permission_diffs/<plan|deploy>-<pack_id>.md`
- `packs/<pack_id>/reports/deploy_<timestamp>.md`

---

## 17) Request/Response Contracts

### Standard Error Response

All error responses use a consistent shape:

```json
{
  "error": {
    "code": "<HTTP_STATUS>",
    "message": "<human-readable message>",
    "requestId": "<correlation-id>"
  }
}
```

### POST /verify

**Request:**
```json
{
  "token": "<Firebase ID token>",
  "checkRevoked": false
}
```

**Response (200):**
```json
{
  "uid": "abc123",
  "email": "user@example.com",
  "emailVerified": true,
  "claims": { "role": "admin" },
  "iss": "https://securetoken.google.com/<project>",
  "aud": "<project-id>",
  "iat": 1700000000,
  "exp": 1700003600,
  "auth_time": 1700000000
}
```

### POST /batch-verify

**Request:**
```json
{
  "tokens": [
    { "token": "<token1>", "checkRevoked": false },
    { "token": "<token2>", "checkRevoked": true }
  ]
}
```

**Response (200):**
```json
{
  "results": [
    { "valid": true, "uid": "abc123", "email": "user@example.com", "claims": {} },
    { "valid": false, "error": "Token has been revoked" }
  ],
  "summary": { "total": 2, "valid": 1, "invalid": 1 }
}
```

### POST /users

**Request:**
```json
{
  "email": "new@example.com",
  "password": "securePassword123",
  "displayName": "New User",
  "phoneNumber": "+15555550100",
  "emailVerified": false,
  "disabled": false
}
```

**Response (201):**
```json
{
  "uid": "generated-uid",
  "email": "new@example.com",
  "displayName": "New User",
  "phoneNumber": "+15555550100",
  "emailVerified": false,
  "disabled": false,
  "metadata": {
    "creationTime": "2026-02-27T00:00:00Z",
    "lastSignInTime": null,
    "lastRefreshTime": null
  },
  "customClaims": {},
  "providerData": []
}
```

### POST /sessions

**Request:**
```json
{
  "idToken": "<Firebase ID token>",
  "expiresIn": 604800000
}
```

**Response (200):**
```json
{
  "sessionCookie": "<signed-session-cookie>",
  "expiresIn": 604800000
}
```

### POST /tokens/custom

**Request:**
```json
{
  "uid": "abc123",
  "claims": { "role": "admin", "tier": "premium" }
}
```

**Response (200):**
```json
{
  "customToken": "<signed-custom-token>",
  "uid": "abc123"
}
```

---

## 18) Definition of Done

**Functional:**
- All 22 endpoints respond correctly for valid inputs
- Token verification works with and without `checkRevoked`
- User CRUD operations create, read, update, and delete users
- Custom claims can be set and deleted, with 1000-byte limit enforced
- Session cookies can be created and verified
- Custom tokens can be minted with optional claims
- Token revocation invalidates subsequent verification with `checkRevoked`
- Email action links are generated for all three types
- Batch operations respect size limits (25 verify, 100 lookup, 1000 delete)
- Paginated user listing works with `maxResults` and `pageToken`
- Health endpoint returns version and uptime

**Security & Operations:**
- API key authentication enforced on all endpoints except /health and /metrics
- Rate limiting active per operation class with 429 responses
- Audit logging for all mutations with correlation IDs
- Prometheus metrics exposed at /metrics
- Graceful shutdown completes within 10s timeout
- All error responses use generic messages (no information leakage)
- Input validation at all system boundaries

**Quality:**
- TypeScript compiles with zero errors
- All tests pass
- Evidence bundle is complete, secrets redacted
- Smoke tests pass end-to-end

---

## 19) Future Enhancements (v2.0+)

- Multi-tenancy (Identity Platform tenant isolation)
- MFA enrollment management (TOTP, phone)
- OIDC/SAML provider configuration
- User import with password hashes
- Project-level auth configuration (sign-in methods, authorized domains)
- Multi-environment support (dev/stage/prod)
- Claims-based authorization middleware
- WebSocket real-time user change events

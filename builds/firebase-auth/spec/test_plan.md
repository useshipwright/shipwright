# Test Plan — PRD — Firebase Auth Verification Service

## JWT structure pre-validation (lib/validate-jwt.ts)

**What to test:** isValidJwtStructure() validates token strings have exactly 3 base64url-encoded segments separated by dots, without verifying signature or claims.


**How to test:** Direct function calls with various input strings. No mocking needed — this is a pure function.


**Edge cases:**
- Valid 3-segment JWT string returns true
- Empty string returns false
- Null/undefined input returns false (TypeScript boundary)
- String with 2 segments (missing signature) returns false
- String with 4 segments returns false
- String with only dots ('..') returns false
- Segments containing non-base64url characters (e.g., spaces, special chars)
- Extremely long token string (>10KB) — should still validate structure
- Token with empty segments ('a..b') returns false
- Token with padding characters (base64 '=' vs base64url)
- Unicode/multibyte characters in segments
- Token string with leading/trailing whitespace

**Mocking:** None — pure function, no external dependencies


## Email redaction (lib/redact.ts)

**What to test:** redactEmail() transforms emails to first-char + *** + @domain format per ADR-007 (e.g., t***@example.com).


**How to test:** Direct function calls with various email formats.

**Edge cases:**
- Standard email: test@example.com → t***@example.com
- Single-character local part: a@b.com → a***@b.com
- Email with plus addressing: test+tag@example.com → t***@example.com
- Email with dots in local part: first.last@example.com → f***@example.com
- Empty string input
- String without @ symbol
- Multiple @ symbols in string
- Null/undefined input
- Very long email (>254 chars)
- Email with subdomain: user@mail.example.co.uk

**Mocking:** None — pure function


## UID redaction (lib/redact.ts)

**What to test:** redactUid() transforms UIDs to first-4-chars + *** format per ADR-007 (e.g., abc1***).


**How to test:** Direct function calls with various UID formats.

**Edge cases:**
- Standard UID: abcdef123456 → abcd***
- UID shorter than 4 chars: ab → ab***
- UID exactly 4 chars: abcd → abcd***
- Empty string input
- Null/undefined input
- UID at max length (128 chars)
- UID with special characters (hyphens, underscores)

**Mocking:** None — pure function


## Sensitive data redaction (lib/redact.ts)

**What to test:** redactSensitive() detects and scrubs JWT tokens, service account JSON, and bearer tokens from arbitrary objects.


**How to test:** Pass objects containing sensitive patterns and verify they are replaced with redaction markers.


**Edge cases:**
- Object containing a JWT-shaped string (3 dot-separated segments) → first 10 chars + [REDACTED]
- Object containing 'private_key' field (service account JSON pattern) → [REDACTED_CREDENTIAL]
- Object containing 'Bearer eyJ...' string → redacted
- Nested objects with sensitive values at multiple depths
- Array values containing sensitive strings
- Object with no sensitive values passes through unchanged
- Null/undefined values in object properties
- String that looks like JWT but is actually a legitimate 3-dot-separated value
- FIREBASE_SERVICE_ACCOUNT_JSON value in any field

**Mocking:** None — pure function


## Firebase Admin adapter (adapters/firebase-admin.ts)

**What to test:** initFirebase() calls firebase-admin initializeApp with cert() credential. getFirebaseAuth() returns the Auth instance. Credential isolation — this is the ONLY module that touches firebase-admin.


**How to test:** Mock firebase-admin/app and firebase-admin/auth modules. Verify initializeApp is called with cert(parsed JSON), getAuth() is called, and the Auth instance is returned.


**Edge cases:**
- Valid JSON string credential initialises SDK successfully
- Invalid JSON string throws during parse (before cert())
- JSON missing required fields (projectId, clientEmail, privateKey) — cert() throws
- getFirebaseAuth() called before initFirebase() — should throw or return undefined
- Double initFirebase() call — should handle idempotently or throw
- Private key with literal \n sequences (needs \n → newline conversion)

**Mocking:** vi.mock('firebase-admin/app') for initializeApp and cert. vi.mock('firebase-admin/auth') for getAuth.



## Correlation ID plugin (plugins/correlation-id.ts)

**What to test:** Plugin reads X-Request-ID from incoming headers, propagates it if present, generates UUID v4 if absent. Attaches correlationId to request and response headers.


**How to test:** Register plugin on a minimal Fastify instance with a test route that returns request.correlationId. Use inject() to send requests.


**Edge cases:**
- Request with X-Request-ID header → same value in response header and request.correlationId
- Request without X-Request-ID → UUID v4 generated, returned in response header
- Empty X-Request-ID header → generates new UUID
- X-Request-ID with special characters or very long value
- Multiple concurrent requests get distinct correlation IDs
- Correlation ID format validation (is it a valid UUID when generated)

**Mocking:** No external mocks needed. Use Fastify inject().


## Firebase plugin (plugins/firebase.ts)

**What to test:** Plugin reads FIREBASE_SERVICE_ACCOUNT_JSON env var, calls adapter.initFirebase(), decorates Fastify instance with app.firebaseAuth. Fails fast if init fails.


**How to test:** Mock the firebase-admin adapter. Register plugin on Fastify instance. Verify decorator is set and init is called.


**Edge cases:**
- Valid credential in env var → firebaseAuth decorator is set
- Missing FIREBASE_SERVICE_ACCOUNT_JSON env var → plugin throws (fail-fast)
- Adapter.initFirebase() throws → plugin propagates error (container won't start)
- Logs SDK init status on success
- Logs error on failure

**Mocking:** vi.mock('../adapters/firebase-admin.js') to control initFirebase() and getFirebaseAuth() return values.



## Logging plugin (plugins/logging.ts)

**What to test:** Plugin configures Pino for structured JSON output, applies redaction serializers, injects correlationId into log entries.


**How to test:** Register correlation-id and logging plugins on Fastify. Capture log output (pipe Pino to a writable stream). Verify JSON structure, severity mapping, and redaction.


**Edge cases:**
- Log entry contains correlationId from request
- Email in log data is redacted via serializer
- UID in log data is redacted via serializer
- Token string in log data is redacted
- Log entry has Cloud Logging compatible severity field
- Log entry has correct message key per GCP config

**Mocking:** Capture Pino output stream. correlation-id plugin is real (no mock).



## Health endpoint (GET /health) — REQ-004

**What to test:** Returns 200 with status, firebase_initialized, version, timestamp. Works without Firebase init (for smoke tests and probes).


**How to test:** Use buildApp({ skipFirebaseInit: true }) since health route is always registered. Test with inject().


**Edge cases:**
- Returns 200 with { status: 'healthy', firebase_initialized, version, timestamp }
- When Firebase is not initialized → firebase_initialized: false, status: 'degraded' or 'healthy'
- When Firebase IS initialized → firebase_initialized: true
- Response includes valid ISO 8601 timestamp
- Response includes version from package.json
- GET method works, other methods return 404 or 405
- No authentication required

**Mocking:** buildApp({ skipFirebaseInit: true }) — no Firebase mocking needed.



## Single token verification (POST /verify) — REQ-001, REQ-005, REQ-008, REQ-009

**What to test:** Accepts { token }, validates JWT structure, calls firebaseAuth.verifyIdToken(), returns uid/email/claims/metadata on success, generic 401 on any failure, 400 on bad input.


**How to test:** Manual Fastify construction per ADR-011: register sensible, correlation-id, logging, fake firebase plugin (fp with name 'firebase' decorating firebaseAuth with mock verifyIdToken), then register verify route. Use inject() for all scenarios.


**Edge cases:**
- Valid token → 200 with uid, email, email_verified, name, picture, custom_claims, token_metadata
- Valid token with no email (anonymous user) → 200 with email: null
- Valid token with custom claims → custom_claims populated
- Valid token with no custom claims → custom_claims: {}
- Token metadata includes iat, exp, auth_time, iss, sign_in_provider
- Expired token (auth/id-token-expired) → generic 401
- Invalid signature (auth/invalid-id-token) → generic 401
- Wrong audience (auth/invalid-argument) → generic 401
- Revoked token (auth/id-token-revoked) → generic 401
- 401 response body is generic — does NOT reveal failure reason
- Missing request body → 400
- Empty object body {} → 400
- Body with token: '' (empty string) → 400
- Body with token: 123 (wrong type) → 400
- Body with invalid JWT structure (not 3 segments) → 400 (pre-SDK validation)
- Content-Type not application/json → 400 or 415
- Extra fields in body are ignored (no strict additionalProperties)
- Very long token string (>64KB)
- Response includes X-Request-ID header
- Verification result is logged with redacted UID
- Latency is logged
- Failure reason is logged server-side (not in response)

**Mocking:** Fake firebase plugin with vi.fn() for verifyIdToken. Control resolved/rejected values per test case. Use DecodedIdToken fixture for success cases and FirebaseAuthError fixtures for failures.



## Batch token verification (POST /batch-verify) — REQ-002, REQ-009

**What to test:** Accepts { tokens: string[] } (max 25), validates each structure, verifies concurrently via Promise.allSettled, returns per-token results with coarse error categories.


**How to test:** Manual Fastify construction per ADR-011 with fake firebase plugin. Mock verifyIdToken to resolve/reject per call using mockImplementation based on token value.


**Edge cases:**
- All tokens valid → 200, all results valid:true with claims
- All tokens invalid → 200, all results valid:false with error category
- Mix of valid and invalid tokens → 200, correct per-token results
- One expired token among valid ones → that token shows error:'expired', others valid
- One malformed token (fails structure validation) → error:'malformed', SDK not called for it
- One invalid-signature token → error:'invalid'
- Results are in same order as input tokens
- Summary counts are correct (total, valid, invalid)
- Exactly 25 tokens → accepted
- 26 tokens → 400
- 0 tokens (empty array) → 400
- Missing tokens field → 400
- tokens is not an array → 400
- tokens contains non-string element → 400
- Missing request body → 400
- Single token in array → works (min 1)
- Batch summary is logged (total, valid count, invalid count)
- Per-token error categories: expired = auth/id-token-expired, malformed = structure fail, invalid = everything else
- Error category mapping: auth/id-token-revoked → 'invalid' (not 'expired')
- Error category mapping: auth/invalid-id-token → 'invalid'
- Error category mapping: auth/argument-error → 'invalid'
- Concurrent verification — one slow token does not block others (Promise.allSettled)
- Response includes X-Request-ID header

**Mocking:** Fake firebase plugin with vi.fn() for verifyIdToken. Use mockImplementation that switches on token value to return different results for different tokens in the same batch.



## User lookup (GET /user-lookup/:uid) — REQ-003

**What to test:** Accepts UID path parameter, validates format, calls firebaseAuth.getUser(), returns user profile on success, 404 for unknown, 400 for malformed.


**How to test:** Manual Fastify construction per ADR-011 with fake firebase plugin mocking getUser.


**Edge cases:**
- Valid UID → 200 with full profile (uid, email, display_name, photo_url, phone_number, disabled, custom_claims, provider_data, metadata)
- Valid UID for user with no email → email: null
- Valid UID for user with no custom claims → custom_claims: null
- Valid UID for disabled user → disabled: true
- Valid UID with multiple providers → provider_data array has multiple entries
- Valid UID with no providers → provider_data: []
- Metadata includes creation_time, last_sign_in_time, last_refresh_time
- Unknown UID (auth/user-not-found) → 404
- Empty UID path parameter → 400
- UID exceeding 128 characters → 400
- UID with invalid characters (spaces, special chars beyond hyphens/underscores) → 400
- UID with only hyphens/underscores (valid chars but edge case)
- UID at exactly 128 characters → accepted
- Firebase SDK error (auth/internal-error) → 500
- Firebase SDK error (app/invalid-credential) → 500
- Lookup is logged with partially redacted UID
- Response includes X-Request-ID header

**Mocking:** Fake firebase plugin with vi.fn() for getUser. Return UserRecord fixture for success, throw FirebaseAuthError for failures.



## Generic 401 for all token failures — REQ-008

**What to test:** Verify that POST /verify returns identical 401 responses regardless of failure reason. Response body must NOT leak whether token was expired, forged, malformed, revoked, wrong audience, etc.


**How to test:** Call POST /verify with tokens that trigger each Firebase error code. Assert all responses have identical status (401) and identical body structure with generic message.


**Edge cases:**
- auth/id-token-expired → 401 with generic message
- auth/invalid-id-token → 401 with same generic message
- auth/id-token-revoked → 401 with same generic message
- auth/invalid-argument (wrong aud/iss/sub) → 401 with same generic message
- auth/internal-error → should this be 401 or 500? (SDK network failure)
- All 401 response bodies are byte-identical (no timing info, no error codes)
- Detailed reason appears in server-side logs but NOT in response

**Mocking:** Mock verifyIdToken to throw each specific error code. Capture logs to verify server-side detail. Compare response bodies for identity.



## Secret isolation — credential containment — REQ-006

**What to test:** FIREBASE_SERVICE_ACCOUNT_JSON is only accessed in adapters/firebase-admin.ts. No route handler imports the credential module directly.


**How to test:** Static analysis: grep/scan all route files and plugin files (except firebase.ts) for imports of firebase-admin or FIREBASE_SERVICE_ACCOUNT_JSON. This is a code review test, not a runtime test.


**Edge cases:**
- No route file imports adapters/firebase-admin.ts
- No route file reads process.env.FIREBASE_SERVICE_ACCOUNT_JSON
- Only adapters/firebase-admin.ts imports from firebase-admin/app
- plugins/firebase.ts imports from adapter, not firebase-admin directly
- Credential string is not attached to Fastify instance or request

**Mocking:** Static analysis test using file reads and pattern matching. No runtime mocking needed.



## Log redaction enforcement — REQ-007

**What to test:** All log output passes through Pino serializers that redact emails, UIDs, tokens, and secrets. Verify no sensitive data appears in log output during normal request processing.


**How to test:** Capture Pino log output during verify/user-lookup requests. Assert emails are redacted (t***@example.com format), UIDs are redacted (first 4 + ***), tokens are redacted, no credential JSON appears.


**Edge cases:**
- Successful verification logs redacted UID, NOT full UID
- Successful verification does NOT log the token value
- Failed verification logs redacted rejection detail
- User lookup logs partially redacted UID
- Error logs do not contain full stack traces with credential data
- Batch verify summary logs counts but not individual token values
- Redaction applies at all log levels (info, warn, error, debug)

**Mocking:** Capture Pino output stream during route tests. Parse JSON log entries and assert redaction patterns.



## Input validation at system boundaries — REQ-009

**What to test:** All inbound data is validated. Token format (JWT structure) validated before Firebase SDK call. Request bodies validated against schema.


**How to test:** Send malformed requests to each endpoint. Verify 400 is returned and Firebase SDK is NOT called for structurally invalid inputs.


**Edge cases:**
- POST /verify with non-JWT token string → 400, verifyIdToken NOT called
- POST /verify with missing Content-Type → 400 or appropriate error
- POST /batch-verify with >25 tokens → 400, no verification attempted
- POST /batch-verify with non-array tokens → 400
- GET /user-lookup with empty UID → 400, getUser NOT called
- GET /user-lookup with >128 char UID → 400, getUser NOT called
- Malformed JSON body → 400
- Unexpected Content-Type (text/plain, multipart/form-data) → 400

**Mocking:** Fake firebase plugin with spy verifyIdToken/getUser. Assert spy is NOT called when input validation fails.



## Constant-time security operations — REQ-011, ADR-010

**What to test:** Error response timing is normalised on verify endpoint — invalid tokens do not return faster than valid ones. Uses crypto.timingSafeEqual for any direct string comparisons.


**How to test:** Verify timing normalisation code exists and is applied. Test that fast-failing requests (malformed tokens) have a minimum delay before response. Statistical timing test is optional but useful.


**Edge cases:**
- Malformed token (instant local rejection) does not respond faster than network-verified token
- Minimum response delay is applied on error paths
- Timing normalisation does NOT apply to batch-verify (already variable by design)
- Timing normalisation does NOT apply to health endpoint

**Mocking:** Mock verifyIdToken to resolve instantly vs after delay. Measure response times. Verify minimum delay mechanism exists in code.



## App factory and plugin graph (app.ts)

**What to test:** buildApp() assembles the full plugin graph correctly. With skipFirebaseInit: false, all routes are registered. With skipFirebaseInit: true, only health route is registered.


**How to test:** Call buildApp() with both options. Verify registered routes using Fastify's printRoutes() or inject() calls.


**Edge cases:**
- buildApp() with default options (skipFirebaseInit: false) registers all 4 routes
- buildApp({ skipFirebaseInit: true }) registers only /health
- Plugin dependency order: sensible → correlation-id → logging → firebase → routes
- buildApp returns Fastify instance without calling listen()
- Duplicate buildApp() calls create independent instances

**Mocking:** For skipFirebaseInit: false, mock the firebase adapter to prevent real SDK init. For skipFirebaseInit: true, no mocking needed.



## Server startup and graceful shutdown (server.ts)

**What to test:** Process entry point reads PORT, starts Fastify listen, handles SIGTERM/SIGINT for graceful shutdown.


**How to test:** Test server module with mocked buildApp. Verify listen() is called with correct port. Verify signal handlers are registered.


**Edge cases:**
- Default PORT 8080 when env var not set
- Custom PORT from environment variable
- SIGTERM triggers graceful shutdown (app.close())
- SIGINT triggers graceful shutdown
- buildApp failure prevents server start

**Mocking:** Mock buildApp to return a fake Fastify instance. Mock process.on for signal handlers.



## Structured JSON logging — REQ-013

**What to test:** All logs are structured JSON compatible with Cloud Logging. Verify specific log entries for each operation type.


**How to test:** Capture log output during various operations. Parse JSON and verify required fields and format.


**Edge cases:**
- Verification request logs: result (pass/fail), redacted uid, latency
- Batch verification logs: summary with total, valid count, invalid count
- User lookup logs: operation type, redacted UID
- Rejected token logs: reason (expired, bad signature, malformed) server-side
- Firebase SDK init status logged at startup
- All log entries include correlationId
- Log entries have GCP-compatible severity field
- Log entries have correct message key (per @google-cloud/pino-logging-gcp-config)

**Mocking:** Capture Pino output stream. Parse JSON entries. Use fake firebase plugin for route tests.



## Request correlation ID — REQ-014

**What to test:** Every request gets a correlation ID (propagated from header or generated). It appears in all logs and response headers.


**How to test:** Send requests with and without X-Request-ID header to each endpoint. Verify response header and log entries.


**Edge cases:**
- Request with X-Request-ID → same value in response header
- Request without X-Request-ID → new UUID in response header
- Correlation ID appears in all log entries for that request
- Each endpoint returns X-Request-ID: verify, batch-verify, user-lookup, health
- Concurrent requests each get their own correlation ID in logs

**Mocking:** Use inject() on assembled Fastify app.


## Response schema conformance

**What to test:** All endpoint responses conform to the data model specification. Verify field names, types, nullability, and structure.


**How to test:** Define JSON Schema for each response and validate actual responses against them. Alternatively, use snapshot testing on response shapes.


**Edge cases:**
- VerifyResponse has all required fields with correct types
- TokenMetadata has iat, exp, auth_time, iss, sign_in_provider (all required)
- BatchVerifyResponse results array matches input length
- BatchTokenResult valid:true includes uid, email, custom_claims, token_metadata
- BatchTokenResult valid:false includes index, error (enum: expired|invalid|malformed)
- BatchSummary total = valid + invalid
- UserLookupResponse has all required fields per data model
- ProviderInfo has provider_id, uid (required), nullable email/display_name/photo_url
- HealthResponse has status enum (healthy|degraded), firebase_initialized boolean
- ErrorResponse has error (string) and statusCode (integer)

**Mocking:** Fake firebase plugin returning fixtures. Validate response bodies against JSON Schema definitions.



## Dockerfile builds and runs (REQ-024)

**What to test:** Multi-stage Dockerfile builds successfully, produces minimal image, runs on Node 20, uses pnpm, non-root user.


**How to test:** docker build the image. Verify it starts and responds on /health. Check image metadata for non-root user and Node 20 runtime.


**Edge cases:**
- Docker build completes without errors
- Container starts and binds to PORT env var
- Health endpoint responds when running in container
- Container runs as non-root user
- Image uses node:20-slim base
- pnpm install uses --frozen-lockfile
- .dockerignore excludes tests, .git, docs, node_modules

**Mocking:** Use docker build and docker run. For health check, mock or skip Firebase init (set skipFirebaseInit env var or similar).



## TypeScript compilation — REQ-022

**What to test:** TypeScript compiles with zero errors in strict mode targeting Node 20.

**How to test:** Run tsc --noEmit (or pnpm build) as a test step.

**Edge cases:**
- Compilation succeeds with zero errors and zero warnings
- Strict mode is enabled in tsconfig.json
- All imports resolve correctly (ESM with .js extensions)
- No implicit any types

**Mocking:** None — compiler check only.


## Test coverage threshold — REQ-023

**What to test:** All tests pass with >80% coverage across lines, branches, and functions.

**How to test:** Run vitest with --coverage. Assert thresholds in vitest.config.ts.

**Edge cases:**
- Line coverage > 80%
- Branch coverage > 80%
- Function coverage > 80%
- Coverage report is generated

**Mocking:** None — coverage is a test runner metric.


## [Smoke] Health endpoint responds

**What to test:** Verifies the service is running and the health endpoint is reachable. This is the minimum viable smoke test that works even without a Firebase test token.


**How to test:** Smoke test: Send GET /health, Assert HTTP 200, Assert response body has status, firebase_initialized, version, timestamp


## [Smoke] Valid token verification

**What to test:** Verifies the core token verification flow works end-to-end with a real Firebase ID token (provided via --verify-token-from-env). SKIPPABLE if no test token is provided.


**How to test:** Smoke test: Obtain test token from FIREBASE_TEST_ID_TOKEN env var, If token not available, mark as SKIPPED and exit, Send POST /verify with { token: <test-token> }, Assert HTTP 200, Assert response contains uid, email, token_metadata


## [Smoke] Invalid token rejection

**What to test:** Verifies that an obviously invalid token is rejected with 401. Uses a hardcoded garbage token string with valid JWT structure.


**How to test:** Smoke test: Send POST /verify with { token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.invalidsig' }, Assert HTTP 401, Assert response body is generic (no failure detail)


## [Smoke] Missing body rejection

**What to test:** Verifies that a request with no body returns 400.


**How to test:** Smoke test: Send POST /verify with empty body, Assert HTTP 400


## [Smoke] Batch verify smoke

**What to test:** Verifies batch endpoint processes a small batch. SKIPPABLE if no test token is provided.


**How to test:** Smoke test: If FIREBASE_TEST_ID_TOKEN available, send POST /batch-verify with { tokens: [<valid>, 'invalid.token.here'] }, Assert HTTP 200, Assert results array length == 2, Assert summary.total == 2


## [Smoke] User lookup smoke

**What to test:** Verifies user lookup endpoint works. SKIPPABLE if no test token or test UID is provided.


**How to test:** Smoke test: If test UID available (extracted from valid token verification), send GET /user-lookup/<uid>, Assert HTTP 200, Assert response contains uid, email, disabled fields


---

# Mocking Strategy

**external_apis:** Firebase Admin SDK is the primary external dependency. All route tests use a fake Fastify plugin (fp with name 'firebase') that decorates the Fastify instance with a mock firebaseAuth object containing vi.fn() stubs for verifyIdToken and getUser. This avoids any network calls to Google APIs. The adapter module (adapters/firebase-admin.ts) is unit-tested separately with vi.mock('firebase-admin/app') and vi.mock('firebase-admin/auth'). For smoke tests against a deployed service, real Firebase tokens are used (from --verify-token-from-env).


**databases:** No database. This is a stateless verification gateway. Firebase Authentication (Identity Platform) is the identity store — mocked via the adapter layer in unit/integration tests. No test database setup or teardown needed.


**time:** Token expiry (iat, exp, auth_time) is tested by controlling the mock verifyIdToken response — mock returns the fixture with desired timestamps, or rejects with auth/id-token-expired. No need to mock Date.now() for most tests. For timing normalisation tests (ADR-010), may need to measure elapsed time or mock setTimeout. Use vi.useFakeTimers() only if testing the minimum response delay mechanism.


**randomness:** UUID generation for correlation IDs is the only random element. For deterministic assertions, either: (1) assert the response header is a valid UUID v4 format, or (2) mock crypto.randomUUID() / uuid.v4() if exact value matters. Generally, format validation is sufficient — exact value matching is unnecessary.


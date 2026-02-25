# Architecture — PRD — Firebase Auth Verification Service

## Overview

A stateless Fastify microservice deployed on GCP Cloud Run that acts as a Firebase Authentication verification gateway. Internal microservices call it to verify Firebase ID tokens, batch-verify tokens, and look up user profiles. The service wraps the Firebase Admin SDK behind an adapter layer, uses plugin-based Fastify composition for modularity, and produces structured JSON logs compatible with Cloud Logging. Deployed via a single deploy script to Cloud Run.


## Components

### server.ts

Process entry point. Reads PORT from env (default 8080), calls buildApp(), starts Fastify listen. Handles SIGTERM/SIGINT for graceful shutdown.


**API Surface:** CLI entry — no programmatic API


### app.ts

Fastify app factory. Exports buildApp(opts) that assembles the full plugin graph. Accepts { skipFirebaseInit: boolean } for testing. When skipFirebaseInit is false (default), registers firebase plugin which initialises the SDK and enables route plugins. When true, registers only health route (for health-only tests). Returns the configured Fastify instance without calling listen().


**Dependencies:** plugins/correlation-id.ts, plugins/logging.ts, plugins/firebase.ts, routes/health.ts, routes/verify.ts, routes/batch-verify.ts, routes/user-lookup.ts

**API Surface:** buildApp(opts?: { skipFirebaseInit?: boolean }): FastifyInstance


### adapters/firebase-admin.ts

Thin adapter wrapping firebase-admin SDK. Exports getFirebaseAuth() which returns the Auth instance. Isolates the Firebase credential (REQ-006) — initializeApp + cert() happen only here. No route handler imports this module directly; they access firebaseAuth via the Fastify decorator set by the firebase plugin.


**API Surface:** initFirebase(credentialJson: string): void; getFirebaseAuth(): Auth


### plugins/firebase.ts

Fastify plugin that calls adapter.initFirebase() with the credential from FIREBASE_SERVICE_ACCOUNT_JSON env var, then decorates the Fastify instance with app.firebaseAuth (the Auth object). Registered with fp() as name 'firebase', depends on ['fastify-sensible']. Logs SDK init status. If init fails, logs error and throws (fail-fast — container won't start).


**Dependencies:** adapters/firebase-admin.ts

**API Surface:** Fastify decorator: app.firebaseAuth (firebase-admin Auth instance)


### plugins/correlation-id.ts

Fastify plugin that reads X-Request-ID from incoming request headers. If present, propagates it; if absent, generates a UUID v4. Attaches correlationId to the request object and adds X-Request-ID to the response headers. Registered with fp() as name 'correlation-id'.


**API Surface:** Fastify request decorator: request.correlationId (string)


### plugins/logging.ts

Configures Fastify's Pino logger for structured JSON output compatible with Cloud Logging. Uses @google-cloud/pino-logging-gcp-config for severity mapping and message key. Applies the redaction serializer (lib/redact.ts) to scrub emails, UIDs, tokens, and secrets from all log output. Injects correlationId into every log entry. Registered with fp() as name 'logging', depends on ['correlation-id'].


**Dependencies:** plugins/correlation-id.ts, lib/redact.ts

**API Surface:** Fastify logger (Pino) with redaction and correlation


### lib/redact.ts

Pure utility module for log redaction. Exports functions to partially redact emails (first char + *** + @domain), UIDs (first 4 chars + ***), and detect/ scrub patterns that look like service account JSON, bearer tokens, or JWT strings. Applied as Pino serializers in the logging plugin.


**API Surface:** redactEmail(email): string; redactUid(uid): string; redactSensitive(obj): obj


### lib/validate-jwt.ts

Pure utility for JWT structure pre-validation (REQ-009). Validates that a token string has exactly 3 base64url-encoded segments separated by dots. Does NOT verify signature or claims — just structural validation before passing to the Firebase SDK, to fail fast on obviously malformed input.


**API Surface:** isValidJwtStructure(token: string): boolean


### routes/health.ts

GET /health endpoint. Returns service status and Firebase SDK init state. No authentication required. Used for Cloud Run liveness/readiness probes and smoke tests. Registered with fp() as name 'health-route'. Always registered regardless of skipFirebaseInit flag.


**API Surface:** GET /health → { status, firebase_initialized, version, timestamp }


### routes/verify.ts

POST /verify endpoint. Accepts { token } in body, validates JWT structure, calls firebaseAuth.verifyIdToken(token), returns uid/email/claims/metadata on success. Returns generic 401 on any verification failure (REQ-008). Returns 400 on missing/malformed body. Logs verification result, redacted uid, and latency. Registered with fp() as name 'verify-route', depends on ['firebase', 'fastify-sensible'].


**Dependencies:** plugins/firebase.ts, lib/validate-jwt.ts

**API Surface:** POST /verify → 200 (token data) | 400 | 401


### routes/batch-verify.ts

POST /batch-verify endpoint. Accepts { tokens: string[] } (max 25). Validates each token structure, verifies all concurrently via Promise.allSettled, returns per-token results. Each result is independently valid or invalid — one failure does not fail the batch. Returns 400 if >25 tokens or malformed body. Logs batch summary. Registered with fp() as name 'batch-verify-route', depends on ['firebase', 'fastify-sensible'].


**Dependencies:** plugins/firebase.ts, lib/validate-jwt.ts

**API Surface:** POST /batch-verify → 200 (per-token results + summary) | 400


### routes/user-lookup.ts

GET /user-lookup/:uid endpoint. Validates UID format (non-empty, ≤128 chars, alphanumeric-ish). Calls firebaseAuth.getUser(uid) via the adapter. Returns user profile on success, 404 for unknown UID, 400 for malformed UID. Logs lookup with partially redacted UID. Registered with fp() as name 'user-lookup-route', depends on ['firebase', 'fastify-sensible'].


**Dependencies:** plugins/firebase.ts

**API Surface:** GET /user-lookup/:uid → 200 (user profile) | 400 | 404


### schemas/

Fastify JSON Schema definitions for request/response validation on each route. Schemas are co-located per route (verify.schema.ts, batch-verify.schema.ts, user-lookup.schema.ts). Fastify validates inbound requests against these schemas automatically, producing 400 errors for non-conforming input.


**API Surface:** Exported JSON Schema objects consumed by route registrations


## Integration Points

- **Firebase Admin SDK** (rest, outbound)
  - Failure mode: SDK init failure: fail-fast, container does not start (no healthy instances). verifyIdToken() failure: caught per-request, returns 401 to caller, logs reason server-side. getUser() failure: caught per-request, returns 404 or 500 depending on error code. Network failure fetching JWKS: SDK throws auth/internal-error, mapped to 500 with generic message.

- **GCP Secret Manager** (rest, inbound)
  - Failure mode: Secret unavailable at startup: Cloud Run fails to create revision, container never starts. Secret mounted as env var via --set-secrets, so failure is at infrastructure level (pre-application).

- **Cloud Logging** (pubsub, outbound)
  - Failure mode: Logging failure is non-blocking. Cloud Run automatically captures stdout/ stderr. Pino writes to stdout; Cloud Logging ingests structured JSON. If Cloud Logging is down, logs buffer in Cloud Run infrastructure.

- **Calling Microservices** (rest, inbound)
  - Failure mode: Callers authenticate via Cloud Run IAM (service-to-service OIDC tokens). Unauthenticated calls rejected at Cloud Run ingress layer (403) before reaching the application. Application-level errors (400, 401, 404) returned per endpoint contract.


## Deployment

- **local:** docker-compose.yaml with single service (firebase-auth) built from template/Dockerfile. Mounts FIREBASE_SERVICE_ACCOUNT_JSON from .env file. Exposes port 8080. Optional: Firebase Auth Emulator for integration tests (set FIREBASE_AUTH_EMULATOR_HOST). Local dev: pnpm dev runs Fastify with tsx watch mode.

- **ci:** GitHub Actions workflow: checkout → pnpm install → TypeScript compile check → ESLint → vitest with coverage (>80% threshold) → Docker build (validate Dockerfile). No deployment in CI — deployment is via deploy script.

- **production:** Cloud Run service with --ingress=internal, --no-allow-unauthenticated. Container image built via Cloud Build, pushed to Artifact Registry. Secret Manager provides FIREBASE_SERVICE_ACCOUNT_JSON as env var at runtime. Dedicated service account with roles/secretmanager.secretAccessor and roles/logging.logWriter. Health check on GET /health for liveness probe.


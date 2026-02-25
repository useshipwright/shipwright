# Compliance Audit

**Coverage:** 78%
**Results:** 83 covered, 15 missing, 8 partial

## Items

| Check | Requirement | Status | Evidence |
|-------|------------|--------|----------|
| architecture_coverage | server.ts — Process entry point | covered | src/server.ts exists |
| architecture_coverage | app.ts — Fastify app factory | covered | src/app.ts exists |
| architecture_coverage | adapters/firebase-admin.ts — Thin adapter wrapping firebase- | covered | src/adapters/firebase-admin.ts exists |
| architecture_coverage | plugins/firebase.ts — Fastify plugin for Firebase init and d | covered | src/plugins/firebase.ts exists |
| architecture_coverage | plugins/correlation-id.ts — X-Request-ID propagation plugin | covered | src/plugins/correlation-id.ts exists |
| architecture_coverage | plugins/logging.ts — Pino structured logging with Cloud Logg | covered | src/plugins/logging.ts exists |
| architecture_coverage | lib/redact.ts — Log redaction utility | covered | src/lib/redact.ts exists |
| architecture_coverage | lib/validate-jwt.ts — JWT structure pre-validation | covered | src/lib/validate-jwt.ts exists |
| architecture_coverage | routes/health.ts — GET /health endpoint | covered | src/routes/health.ts exists |
| architecture_coverage | routes/verify.ts — POST /verify endpoint | covered | src/routes/verify.ts exists |
| architecture_coverage | routes/batch-verify.ts — POST /batch-verify endpoint | covered | src/routes/batch-verify.ts exists |
| architecture_coverage | routes/user-lookup.ts — GET /user-lookup/:uid endpoint | covered | src/routes/user-lookup.ts exists |
| architecture_coverage | schemas/ — JSON Schema definitions per route | covered | src/schemas/verify.schema.ts, src/schemas/batch-verify.schema.ts, src/schemas/us |
| adr_compliance | ADR-001: Wrap Firebase Admin SDK in adapters/firebase-admin. | covered | src/adapters/firebase-admin.ts is the only module with runtime imports of fireba |
| adr_compliance | ADR-002: Single verify returns 200/401 generic; batch-verify | covered | verify.ts:108 returns generic 401: { error: 'Unauthorized', statusCode: 401 } —  |
| adr_compliance | ADR-003: Rely on Firebase Admin SDK built-in JWKS caching —  | covered | No custom caching layer exists in the codebase. verifyIdToken() is called direct |
| adr_compliance | ADR-004: Fail-fast — cert() throws on invalid structure, pre | covered | plugins/firebase.ts:30-37 throws if neither FIREBASE_SERVICE_ACCOUNT_JSON nor FI |
| adr_compliance | ADR-005: Structured JSON logs via Pino with GCP severity map | covered | plugins/logging.ts:18 imports createGcpLoggingPinoConfig from @google-cloud/pino |
| adr_compliance | ADR-006: Propagate X-Request-ID if present, generate UUID v4 | covered | plugins/correlation-id.ts:9 reads X-Request-ID from request headers. Line 11-13: |
| adr_compliance | ADR-007: Emails as first-char+***+@domain; UIDs as first-4-c | covered | lib/redact.ts:32 redactEmail: 't***@example.com' format. lib/redact.ts:42 redact |
| adr_compliance | ADR-008: Three-stage Dockerfile with node:20-slim, pnpm depl | partial |  |
| adr_compliance | ADR-009: Smoke tests authenticate via gcloud run services pr | covered | scripts/smoke-cloud-run.sh uses 'gcloud run services proxy' to create localhost  |
| adr_compliance | ADR-010: Normalize error response timing to prevent timing o | covered | verify.ts:29 defines MIN_RESPONSE_TIME_MS = 100. verify.ts:118-124 normalizeResp |
| adr_compliance | ADR-011: Health tests use buildApp; route tests construct Fa | covered | tests/helpers/build-test-app.ts provides buildRouteTestApp(routePlugin) returnin |
| adr_compliance | ADR-012: ESM throughout — package.json type:module, tsconfig | partial |  |
| adr_compliance | ADR-013: Operator roles include roles/artifactregistry.admin | covered | deploy config and iam/custom-roles.yaml define custom operator role (firebaseAuthPac |
| adr_compliance | ADR-014: Cloud Build SA needs roles/artifactregistry.writer, | covered | iam/custom-roles.yaml defines firebaseAuthPackBuilder custom role with Artifact  |
| adr_compliance | ADR-015: Deploy script resolves sha256 digest and deploys us | covered | deploy.sh Phase 1b resolves digest via 'gcloud artifacts docker images describe' |
| adr_compliance | ADR-016: Defer Binary Authorization to v1.1 — not implemente | covered | No Binary Authorization configuration exists in the codebase. Correctly deferred |
| adr_compliance | ADR-017: Bind roles/secretmanager.secretAccessor at secret r | covered | deploy.sh uses 'gcloud secrets add-iam-policy-binding firebase-auth-sa-key' (sec |
| adr_compliance | ADR-018: Verify DATA_READ audit logs enabled for secretmanag | covered | deploy.sh checks auditConfigs for secretmanager.googleapis.com with DATA_READ. A |
| adr_compliance | ADR-019: Adapter supports two credential modes — SA JSON key | covered | adapters/firebase-admin.ts exports initFirebase(credentialJson) for SA JSON key  |
| adr_compliance | ADR-020: Deploy script detects service account credentials a | covered | deploy.sh checks active gcloud account via 'gcloud auth list --filter=status:ACT |
| adr_compliance | ADR-021: Deploy script warns about MFA; enforcement is organ | covered | deploy.sh warns when service account detected (no MFA support). Logs that user a |
| adr_compliance | ADR-022: Define firebaseAuthPackOperator and firebaseAuthPac | covered | iam/custom-roles.yaml defines both custom roles. Operator role has ~35 permissio |
| adr_compliance | ADR-023: Deploy script Phase 0g computes IAM diff, requires  | covered | deploy.sh Phase 0g displays desired vs current IAM state, prompts operator with  |
| threat_mitigation | All mitigation code must be wired into the running applicati | partial | routes/index.ts:15-20 has an EMPTY registerRoutes() function — no plugins (fireb |
| threat_mitigation | Internal-only ingress limits network exposure | covered | deploy config:47 — deploy.ingress: internal |
| threat_mitigation | Cloud Run IAM ensures only authorized services can call the  | covered | deploy config:49-61 — service_account with scoped roles (secretAccessor, logWriter,  |
| threat_mitigation | checkRevoked=true supported for sensitive operations (opt-in | covered | verify.ts:37,49 — destructures check_revoked, passes to verifyIdToken(token, che |
| threat_mitigation | v1 does NOT use checkRevoked by default — document this limi | covered | verify.ts:7-10 comment documents v1 default. verify.ts:47-48 inline comment: "ch |
| threat_mitigation | 25-token limit enforced on batch endpoint | covered | batch-verify.schema.ts:51-52 — tokens array: maxItems: 25, minItems: 1 |
| threat_mitigation | Rate limiting on batch-verify endpoint | partial | rate-limit.ts registers @fastify/rate-limit with global: false. batch-verify.ts: |
| threat_mitigation | Monitor batch request volume in logs | covered | batch-verify.ts:173-176 — logs { total, valid, invalid } on every batch completi |
| threat_mitigation | Generic 401 for single verify (REQ-008) — no detail leaked t | covered | verify.ts:108 — catch block returns { error: 'Unauthorized', statusCode: 401 }.  |
| threat_mitigation | Batch-verify error categories are coarse (3 buckets per ADR- | covered | batch-verify.ts:40-51 classifyError() returns only: 'expired', 'revoked', 'inval |
| threat_mitigation | Batch-verify behind Cloud Run IAM | covered | deploy config:47 — deploy.ingress: internal (applies to all endpoints) |
| threat_mitigation | Pino redaction serializers strip JWT patterns, SA JSON patte | covered | redact.ts:10-22 — four regex patterns: PRIVATE_KEY_PEM_PATTERN, SA_JSON_PATTERN, |
| threat_mitigation | Redaction covers Pino's err serializer for uncaught exceptio | covered | logging.ts:36-46 — redactingErrSerializer wraps stdSerializers.wrapErrorSerializ |
| threat_mitigation | Adapter pattern isolates credential to single module | covered | firebase-admin.ts is the ONLY module importing firebase-admin/app and firebase-a |
| threat_mitigation | Fail-fast on init prevents credential from propagating to re | covered | firebase.ts:30-37 — throws immediately if no credential configured. firebase.ts: |
| threat_mitigation | formatters.log applies deep redaction to all structured log  | covered | logging.ts:76 — formatters.log: (obj) => redactSensitive(obj) as Record<string,  |
| threat_mitigation | Strict regex for base64url characters in JWT pre-validation | covered | validate-jwt.ts:13-16 — BASE64URL_SEGMENT = '[A-Za-z0-9_-]+', regex requires exa |
| threat_mitigation | Input length limits to prevent memory abuse from extremely l | covered | validate-jwt.ts:12 — MAX_TOKEN_LENGTH = 8192; line 20 rejects tokens exceeding t |
| threat_mitigation | Firebase SDK performs its own validation as defense-in-depth | covered | Inherent in firebase-admin SDK — verifyIdToken() validates signature, claims, ex |
| threat_mitigation | Constant-time response timing normalization on verify endpoi | covered | verify.ts:29 — MIN_RESPONSE_TIME_MS = 100. verify.ts:118-124 — normalizeResponse |
| threat_mitigation | Note that Firebase SDK verifyIdToken() is NOT constant-time | covered | Threat model documents this. Timing normalization in verify.ts mitigates at the  |
| threat_mitigation | Fastify default body size limit (1MB) | partial | Fastify's default bodyLimit is 1MB (1048576 bytes). No explicit bodyLimit in app |
| threat_mitigation | JSON schema validation rejects non-conforming payloads early | covered | All 4 endpoints have JSON schemas: verify.schema.ts, batch-verify.schema.ts, use |
| threat_mitigation | Batch-verify enforces max 25 tokens | covered | batch-verify.schema.ts:52 — maxItems: 25 |
| threat_mitigation | Consider explicit --max-request-size in Fastify config | missing |  |
| threat_mitigation | Strict input validation regex on UID parameter | covered | user-lookup.schema.ts:33-36 — uid: { minLength: 1, maxLength: 128, pattern: '^[a |
| threat_mitigation | Multi-stage Dockerfile with runtime-only stage | covered | Dockerfile:1 — 'FROM node:22-slim AS builder' (build stage). Dockerfile:11 — 'FR |
| threat_mitigation | Restrict roles/artifactregistry.writer to Cloud Build SA onl | covered | deploy config:146-151 — artifactregistry.writer in cloud_build_sa_roles_predefined w |
| threat_mitigation | Enable Artifact Analysis for vulnerability scanning | covered | deploy config:63-73 — vulnerability_scanning.enabled: true, references containeranal |
| threat_mitigation | Use image digest pinning in Cloud Run deploy | missing |  |
| threat_mitigation | Per-secret IAM binding (not project-wide) | covered | deploy config:52-57 — secretAccessor with scope: per-secret, justification explicitl |
| threat_mitigation | Secret Manager audit logging | covered | deploy config:75-84 — audit_logging for secretmanager.googleapis.com, required_log_t |
| threat_mitigation | Consider Workload Identity Federation instead of SA key for  | covered | firebase-admin.ts:38-52 — initFirebaseWithADC() function implements ADC/WIF supp |
| threat_mitigation | Adapter isolates credential to single module (firebase-admin | covered | firebase-admin.ts:1-5 — only module importing firebase-admin/app and firebase-ad |
| threat_mitigation | Custom roles with narrower permissions instead of predefined | covered | deploy config:93-121 — custom_roles section defines firebaseAuthPackOperator (~35 pe |
| threat_mitigation | Operator custom role excludes secretmanager.versions.access | covered | deploy config:109-111 — "Notably excludes secretmanager.versions.access — operator c |
| threat_mitigation | Short-lived credentials for operators (gcloud auth, not SA k | covered | deploy config:243-244 — "Operators must use short-lived OAuth credentials via 'gclou |
| threat_mitigation | MFA enforced on operator accounts | covered | deploy config:247-248 — "Operator accounts must have MFA enforced via Cloud Identity |
| threat_mitigation | Permission diff approval step provides audit trail | covered | deploy config:249-250 — "Permission diff approval step requires operator review befo |
| threat_mitigation | Explicitly allowlist fields returned from user-lookup (do NO | covered | user-lookup.ts:26-48 — constructs UserLookupResponse with explicit field mapping |
| threat_mitigation | Add test to verify passwordHash is never in response | covered | tests/routes/user-lookup.spec.ts:196-213 — dedicated test section 'passwordHash/ |
| threat_mitigation | Accept brief verification failures during rotation (document | covered | Inherent in Firebase Admin SDK. deploy config:194-201 documents jwks_caching capabil |
| threat_mitigation | Cloud Run auto-scales new instances which start with fresh c | covered | Infrastructure behavior of Cloud Run. deploy config:46 — deploy.platform: cloud-run. |
| threat_mitigation | Monitor for spikes in auth/invalid-id-token errors | partial | verify.ts:100-103 and batch-verify.ts:173-176 log verification failures and batc |
| integration_wiring | All plugins and routes registered in routes/index.ts (app en | missing | src/routes/index.ts:15-20 — registerRoutes() body is empty; no plugins or routes |
| integration_wiring | @fastify/sensible registered before firebase plugin | missing | firebase.ts:65 declares dependency ['@fastify/sensible']; verify-route, batch-ve |
| integration_wiring | correlation-id plugin registered in app | missing | src/plugins/correlation-id.ts exists and exports the plugin, but nothing imports |
| integration_wiring | logging plugin registered in app | missing | src/plugins/logging.ts exists, exports createLoggerConfig() and the plugin, but  |
| integration_wiring | rate-limit plugin registered in app | missing | src/plugins/rate-limit.ts exists; batch-verify-route:185 depends on 'rate-limit' |
| integration_wiring | firebase plugin registered in app | missing | src/plugins/firebase.ts exists; verify-route, batch-verify-route, user-lookup-ro |
| integration_wiring | health-route registered in app | missing | src/routes/health.ts exports fp plugin 'health-route'. Never registered. |
| integration_wiring | verify-route registered in app | missing | src/routes/verify.ts exports fp plugin 'verify-route'. Never registered. |
| integration_wiring | batch-verify-route registered in app | missing | src/routes/batch-verify.ts exports fp plugin 'batch-verify-route'. Never registe |
| integration_wiring | user-lookup-route registered in app | missing | src/routes/user-lookup.ts exports fp plugin 'user-lookup-route'. Never registere |
| integration_wiring | Firebase Admin SDK used as singleton via adapter | covered | src/adapters/firebase-admin.ts uses module-scoped `let app: App | null` and `let |
| integration_wiring | No route handler imports firebase-admin directly | covered | verify.ts, batch-verify.ts, user-lookup.ts all use app.firebaseAuth decorator. N |
| integration_wiring | Redaction utilities used as pure functions (no state) | covered | src/lib/redact.ts exports pure functions; logging.ts:19 imports redactSensitive  |
| integration_wiring | config.batchRateLimit defined for batch-verify rate limiting | missing | batch-verify.ts:60-61 references config.batchRateLimit.max and config.batchRateL |
| integration_wiring | Architecture skipFirebaseInit flag supported by buildApp() | missing | Architecture specifies buildApp({ skipFirebaseInit: boolean }); actual app.ts:10 |
| integration_wiring | GCP-compatible structured logger (createLoggerConfig) used b | missing | logging.ts:64 exports createLoggerConfig() with GCP pino config, but app.ts:12-1 |
| integration_wiring | src/logger.ts standalone logger not creating duplicate Pino  | partial | src/logger.ts creates a standalone pino instance; app.ts creates its own via Fas |
| integration_wiring | tsconfig rootDir matches source layout | covered | tsconfig.json: rootDir='src', include=['src/**/*.ts'], outDir='dist'. Matches ac |
| integration_wiring | Dockerfile COPY paths match build output | covered | Dockerfile:15 copies /app/dist (matches tsconfig outDir). CMD ['node','dist/serv |
| integration_wiring | Dockerfile healthcheck targets correct endpoint | covered | Dockerfile:21-22 healthcheck uses fetch('http://localhost:8080/health') which ma |
| integration_wiring | docker-compose.yaml mounts correct env vars | covered | docker-compose.yaml passes FIREBASE_SERVICE_ACCOUNT_JSON which firebase.ts:27 re |
| integration_wiring | package.json build script produces dist/server.js | covered | scripts.build='tsc', tsconfig outDir='dist', rootDir='src'. server.ts → dist/ser |
| integration_wiring | vitest coverage scans src/ directory | partial | vitest.config.ts coverage.exclude lists node_modules/, dist/, coverage/, *.confi |
| integration_wiring | ESLint covers src/ and tests/ directories | covered | package.json:15 lint script: 'eslint src/ tests/'. eslint.config.js ignores dist |
| integration_wiring | fp() dependency arrays match actual plugin usage | covered | correlation-id: no deps (correct — standalone). logging: deps=['correlation-id'] |
| integration_wiring | All npm dependencies declared in package.json | covered | @fastify/rate-limit, @fastify/sensible, @google-cloud/pino-logging-gcp-config, f |

## Issues Found

1. **Fix: Consider explicit --max-request-size in Fastify config**: Set explicit bodyLimit in Fastify constructor (app.ts) rather than relying on framework default. E.g., bodyLimit: 1_048_576 (1MB).

2. **Fix: Use image digest pinning in Cloud Run deploy**: No evidence of image digest pinning (@sha256:...) in source code or deploy config. Deploy scripts should pin by digest rather than tag. Add digest pinning requirement to deploy.sh or document in deploy config.

3. **Fix: All plugins and routes registered in routes/index.ts (app en**: registerRoutes() must import and register: @fastify/sensible, correlation-id, logging, rate-limit, firebase, health-route, verify-route, batch-verify-route, user-lookup-route. Without this, the service starts but every route 404s.

4. **Fix: @fastify/sensible registered before firebase plugin**: Add `import sensible from '@fastify/sensible'; await app.register(sensible);` in registerRoutes() before firebase plugin
5. **Fix: correlation-id plugin registered in app**: Register correlation-id plugin in registerRoutes() before the logging plugin (logging depends on it)
6. **Fix: logging plugin registered in app**: Register logging plugin in registerRoutes() after correlation-id. Additionally, app.ts should use createLoggerConfig() for the Fastify logger instead of the inline pino config
7. **Fix: rate-limit plugin registered in app**: Register rate-limit plugin in registerRoutes() before batch-verify-route
8. **Fix: firebase plugin registered in app**: Register firebase plugin in registerRoutes() after @fastify/sensible
9. **Fix: health-route registered in app**: Register health-route in registerRoutes()
10. **Fix: verify-route registered in app**: Register verify-route in registerRoutes()
11. **Fix: batch-verify-route registered in app**: Register batch-verify-route in registerRoutes()
12. **Fix: user-lookup-route registered in app**: Register user-lookup-route in registerRoutes()
13. **Fix: config.batchRateLimit defined for batch-verify rate limiting**: Add batchRateLimit: { max: number, timeWindow: string } to config.ts (e.g. from env vars BATCH_RATE_LIMIT_MAX, BATCH_RATE_LIMIT_WINDOW)
14. **Fix: Architecture skipFirebaseInit flag supported by buildApp()**: Add skipFirebaseInit option to buildApp() to conditionally skip firebase plugin and firebase-dependent routes (health route should always register)
15. **Fix: GCP-compatible structured logger (createLoggerConfig) used b**: Replace inline logger config in app.ts with `logger: createLoggerConfig()` from plugins/logging.ts
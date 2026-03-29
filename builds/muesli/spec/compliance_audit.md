# Compliance Audit

**Coverage:** 77%
**Results:** 83 covered, 11 missing, 14 partial

## Items

| Check | Requirement | Status | Evidence |
|-------|------------|--------|----------|
| architecture_coverage | Fastify Server | covered | src/server.ts, src/app.ts, src/composition-root.ts, src/plugins/index.ts |
| architecture_coverage | Auth Middleware | covered | src/plugins/auth.ts, tests/unit/auth.test.ts |
| architecture_coverage | Rate Limit Plugin | covered | src/plugins/rate-limit.ts, tests/unit/rate-limit.test.ts |
| architecture_coverage | Meeting Routes | covered | src/routes/meetings.ts, src/services/meeting.ts, src/routes/audio.ts, src/routes |
| architecture_coverage | WebSocket Stream Handler | covered | src/routes/stream.ts, src/plugins/websocket.ts, tests/unit/websocket-stream.test |
| architecture_coverage | Template Routes | covered | src/routes/templates.ts, src/services/template.ts, tests/unit/template-routes.te |
| architecture_coverage | Action Routes | covered | src/routes/actions.ts, src/services/action.ts, tests/unit/action-service.test.ts |
| architecture_coverage | Search Routes | covered | src/routes/search.ts, src/services/search.ts, tests/unit/search-service.test.ts, |
| architecture_coverage | AI Routes | covered | src/routes/ai.ts, src/routes/notes-generate.ts, src/services/ai-qa.ts, src/servi |
| architecture_coverage | Calendar Routes | covered | src/routes/calendar.ts, src/services/calendar.ts, tests/unit/calendar-service.te |
| architecture_coverage | Share Routes | covered | src/routes/share.ts, src/services/share.ts, tests/unit/share-routes.test.ts, tes |
| architecture_coverage | User Routes | covered | src/routes/user.ts, src/services/user.ts, tests/unit/user-routes.test.ts, tests/ |
| architecture_coverage | Audio Processing Worker | covered | src/routes/internal.ts, src/services/audio-processor.ts, src/services/audio.ts,  |
| architecture_coverage | Calendar Sync Worker | covered | src/routes/internal.ts, src/services/calendar-sync-worker.ts, tests/integration/ |
| architecture_coverage | Transcription Adapter | covered | src/adapters/transcription/index.ts, src/adapters/transcription/deepgram.ts, src |
| architecture_coverage | Claude Adapter | covered | src/adapters/claude.ts, tests/unit/claude-adapter.test.ts |
| architecture_coverage | Embedding Adapter | covered | src/adapters/embedding.ts, tests/unit/embedding-adapter.test.ts |
| architecture_coverage | Firestore Adapter | covered | src/adapters/firestore.ts, tests/unit/firestore-adapter.test.ts |
| architecture_coverage | GCS Adapter | covered | src/adapters/gcs.ts, tests/unit/gcs-adapter.test.ts |
| architecture_coverage | Pub/Sub Adapter | covered | src/adapters/pubsub.ts, tests/unit/pubsub-adapter.test.ts |
| adr_compliance | ADR-001: Firestore native vector search with findNearest(),  | covered | dist/adapters/firestore.js defines /embeddings collection, findNearest() with CO |
| adr_compliance | ADR-002: Tokenized searchTokens array fields with array-cont | covered | dist/adapters/firestore.js stores searchTokens on meetings/segments/actions, use |
| adr_compliance | ADR-003: Cloud Scheduler POST to /internal/calendar-sync wit | covered | src/routes/internal.ts registers POST /internal/calendar-sync. src/plugins/auth. |
| adr_compliance | ADR-004: Subcollections for segments, notes, speakers under  | covered | dist/adapters/firestore.js defines segments(meetingId), notes(meetingId), speake |
| adr_compliance | ADR-005: Adapter pattern — typed interfaces, composition roo | covered | src/types/adapters.ts defines interfaces. src/composition-root.ts constructs all |
| adr_compliance | ADR-006: Pub/Sub push to /internal/process-audio with retry  | covered | src/routes/internal.ts:68-113 handles POST /internal/process-audio, parses Pub/S |
| adr_compliance | ADR-007: Standard response envelope {data,meta} for success, | partial |  |
| adr_compliance | ADR-008: Zod schemas as source of truth, converted via zod-t | covered | src/types/api.ts defines Zod schemas. Routes use z.toJSONSchema() with target dr |
| adr_compliance | ADR-009: Use text-embedding-005 (not deprecated text-embeddi | covered | dist/adapters/embedding.js sets VERTEX_MODEL = 'text-embedding-005', matching th |
| adr_compliance | ADR-010: Health readiness probe with Beta/Preview caveat | covered | src/plugins/health.ts:8-9 documents the ADR-010 caveat. GET /health/ready is imp |
| adr_compliance | ADR-011: Fastify Ajv validation is primary, Zod supplements  | covered | Routes convert Zod to JSON Schema for Fastify's Ajv. src/plugins/error-handler.t |
| adr_compliance | ADR-012: Use roles/storage.objectUser instead of objectAdmin | covered | This is an infrastructure/IAM decision, not a code-level concern. The GCS adapte |
| threat_mitigation | Every Firestore query MUST include userId filter derived fro | covered | All service methods (meeting, action, search, calendar, share, template, user-no |
| threat_mitigation | Verify meeting ownership before any operation | covered | firestore.getMeeting() checks meeting.userId === userId. Subcollection access (s |
| threat_mitigation | Unit test that queries always include userId scope | partial |  |
| threat_mitigation | Use cryptographically random shareId (minimum 128 bits) | covered | share.ts uses crypto.randomUUID() which provides 128-bit cryptographically rando |
| threat_mitigation | Rate limit GET /api/share/:shareId | missing |  |
| threat_mitigation | Return identical 404 for expired, revoked, and non-existent  | covered | share.ts returns null for non-existent, expired, and revoked shares. Route handl |
| threat_mitigation | Consider adding HMAC signature to shareIds | missing |  |
| threat_mitigation | Sanitize or clearly delimit user-provided content in prompts | covered | ai-notes.ts uses XML-style delimiters: <transcript>...</transcript> and <user_no |
| threat_mitigation | Validate AI output structure matches expected template secti | covered | ai-notes.ts parses response into structured sections via parseSections(). Action |
| threat_mitigation | Never execute commands or code from AI output | covered | AI output is parsed as text/JSON only. No eval, exec, or shell invocation on Cla |
| threat_mitigation | Per-user concurrent WebSocket connection limits | covered | audio.ts: MAX_CONCURRENT_WS_PER_USER = 2. In-memory activeConnections Map keyed  |
| threat_mitigation | Maximum connection duration (4 hours) | covered | audio.ts: MAX_WS_DURATION_MS = 4 * 60 * 60 * 1000. stream.ts sets absolute durat |
| threat_mitigation | Implement backpressure on incoming audio chunks | partial |  |
| threat_mitigation | Set maximum buffer size per connection | covered | Buffer naturally bounded by 10-second segment flush interval. PCM 16-bit 16kHz m |
| threat_mitigation | Validate PCM audio format (sample rate, bit depth, channels) | missing |  |
| threat_mitigation | Rate limit chunk ingestion per connection | missing |  |
| threat_mitigation | Enforce 500MB limit at Fastify multipart parser level | covered | multipart.ts: FILE_SIZE_LIMIT = 500 * 1024 * 1024 registered at @fastify/multipa |
| threat_mitigation | Streaming upload to GCS to avoid holding file in memory | covered | audio.ts uses pipeline(fileStream, writeStream) from Node.js streams — no in-mem |
| threat_mitigation | Validate Content-Length header before accepting upload | covered | audio.ts route reads content-length header and rejects with 413 if exceeds 500MB |
| threat_mitigation | Reject audio with incorrect MIME types early | covered | audio.ts validates against whitelist of allowed MIME types: webm, wav, mp3, ogg, |
| threat_mitigation | Generate and validate cryptographic state parameter in OAuth | covered | calendar.ts generates HMAC-signed state with structure {payloadB64}.{signature}  |
| threat_mitigation | Bind state to user's session/JWT | covered | State payload includes userId and timestamp. Verification checks parsed.userId ! |
| threat_mitigation | Validate redirect_uri strictly matches configured callback U | covered | redirect_uri passed to Google OAuth2 client at construction time via config.goog |
| threat_mitigation | Store refresh tokens encrypted with application-level encryp | covered | TokenEncryptor in utils/crypto.ts uses AES-256-GCM with IV and auth tag. Key man |
| threat_mitigation | Request only calendar.readonly and calendar.events.readonly  | covered | google-calendar.ts requests only calendar.readonly and calendar.events.readonly  |
| threat_mitigation | Consider verifyIdToken with checkRevoked=true for sensitive  | missing |  |
| threat_mitigation | Ensure HTTPS-only for all endpoints | partial |  |
| threat_mitigation | Share endpoint must strip attendee emails | covered | share.ts view() returns only { name: a.name } for attendees, explicitly strippin |
| threat_mitigation | Error responses must not include stack traces in production | covered | errors.ts returns only status code, error name, and sanitized message. 5xx error |
| threat_mitigation | Zod validation errors should be sanitized | covered | Validation errors processed through extractValidationDetails() which extracts fi |
| threat_mitigation | Never return raw Firestore document IDs that could reveal da | partial |  |
| threat_mitigation | Use Pino redaction for request bodies containing transcript  | covered | logger.ts configures comprehensive Pino redaction paths: email, attendeeEmail, a |
| threat_mitigation | Redact Authorization headers | covered | app.ts redacts req.headers.authorization, *.password, *.token, *.secret. logger. |
| threat_mitigation | Rate limit AI endpoints at 10 req/min per user | covered | rate-limit.ts: AI_MAX = 10, AI_WINDOW = '1 minute'. Applied to /api/ai/* and /ap |
| threat_mitigation | Set maximum transcript length for note generation | covered | config.ts: maxTranscriptTokens = 100,000. transcript-truncation.ts truncates tra |
| threat_mitigation | Implement cost tracking per user | partial |  |
| threat_mitigation | Queue AI operations rather than processing synchronously whe | missing |  |
| threat_mitigation | Dead-letter failed AI operations to prevent infinite retry l | missing |  |
| threat_mitigation | Validate WHISPER_ENDPOINT, DIARIZATION_ENDPOINT, EMBEDDING_E | covered | embedding.ts validateEndpointUrl() and whisper.ts validateEndpoint() require HTT |
| threat_mitigation | Do not follow redirects from these endpoints | covered | All three adapters set redirect: 'error' on fetch calls — embedding adapter call |
| threat_mitigation | Do not allow endpoints to be set via API or user input | covered | Endpoints configured via environment variables only (config.ts). No API routes a |
| threat_mitigation | Set request timeouts | covered | AbortSignal.timeout() used on HTTP calls (300s for Whisper). Retry logic with ex |
| threat_mitigation | System templates must be immutable (403 on PUT/DELETE) | covered | template.ts update/delete check if (existing.isSystem) return 'system'. Route ha |
| threat_mitigation | Verify template ownership in service layer | covered | template.ts update checks existing.userId !== userId, delete checks existing.use |
| threat_mitigation | Ensure isSystem flag cannot be set via user API | covered | template.ts create() hardcodes isSystem: false for user-created templates. The f |
| threat_mitigation | DELETE /api/me must cascade to all user data | covered | user.ts deleteAccount() calls gcs.deleteByPrefix('audio/{userId}/') for GCS audi |
| threat_mitigation | Verify OIDC token on /internal/ endpoints | covered | auth.ts checks all /internal/* endpoints, extracts Bearer token, calls verifyOid |
| threat_mitigation | Validate token audience matches Cloud Run service URL | partial |  |
| threat_mitigation | Process messages idempotently | partial |  |
| threat_mitigation | Use dead-letter topic to prevent infinite retries | missing |  |
| threat_mitigation | Do not log signed URLs | covered | gcs.ts explicitly logs only the path: logger.info({ path }, 'Signed URL generate |
| threat_mitigation | Signed URLs should only be generated for the meeting owner | covered | Meeting ownership verified via userId before any audio access. Share service val |
| threat_mitigation | Semantic search must be scoped to authenticated user's embed | covered | search.ts always passes userId to vectorSearch(). firestore.ts vectorSearch() ap |
| integration_wiring | All adapters created as singletons in composition root | covered | composition-root.ts:42-57 creates one instance each of firestore, gcs, pubsub, c |
| integration_wiring | All services created as singletons in composition root | covered | composition-root.ts:68-91 creates one instance per service; no service factory i |
| integration_wiring | TranscriptionAdapter used as singleton | partial | composition-root.ts:19,97 imports createTranscriptionAdapter factory but passes  |
| integration_wiring | Dependency graph flows server.ts → composition-root → app →  | covered | server.ts:5-6 calls createDependencies() then buildApp(deps); app.ts:60-62 calls |
| integration_wiring | Single error handler registered | partial | app.ts:60 calls registerErrorHandler(app) from errors.ts which calls app.setErro |
| integration_wiring | Auth middleware registered on /api/* routes | covered | plugins/index.ts:41 registers auth plugin; auth.ts:256 hooks onRequest for /api/ |
| integration_wiring | Internal routes verify OIDC tokens | covered | auth.ts:238-253 checks /internal/* paths, extracts Bearer token, calls verifyOid |
| integration_wiring | Share routes enforce per-share access rules | partial | auth.ts:213-235 handles /api/share/:shareId but accesses firestoreAdapter via ap |
| integration_wiring | Global rate limit: 100 req/min per userId on /api/* | covered | rate-limit.ts:9,57-66 registers @fastify/rate-limit with GLOBAL_MAX=100, window  |
| integration_wiring | AI tier rate limit: 10 req/min on /api/ai/* | covered | rate-limit.ts:11,70-82 registers child plugin with AI_MAX=10, allowList inverts  |
| integration_wiring | Health and share-public routes excluded from rate limiting | covered | rate-limit.ts:15-22 isExcluded() checks /health, /health/ready, /metrics, /api/s |
| integration_wiring | All required plugins registered in plugins/index.ts | covered | plugins/index.ts registers: error-handler, helmet, cors, health, auth, rate-limi |
| integration_wiring | Response envelope plugin registered | missing | utils/response.ts exports a Fastify plugin that decorates reply with envelope()/ |
| integration_wiring | All architectural routes registered in routes/index.ts | covered | routes/index.ts:31-119 registers meeting, audio, stream, user-notes, notes-gener |
| integration_wiring | Health check routes not duplicated | partial | Health checks exist in TWO places: plugins/health.ts (registered as plugin at /h |
| integration_wiring | Health readiness probe checks Firestore and GCS | missing | plugins/health.ts:49 uses opts.firestore?.healthCheck() and opts.gcs?.healthChec |
| integration_wiring | Dockerfile COPY paths match actual source layout | covered | Dockerfile copies dist/, node_modules/, package.json from builder stage. tsconfi |
| integration_wiring | Dockerfile uses correct Node version | partial | Dockerfile uses node:22-slim but architecture doc specifies 'Node 20+'. Node 22  |
| integration_wiring | tsconfig entry points reference correct directories | covered | tsconfig.json: rootDir=src, outDir=dist, include=[src/**/*.ts], exclude=[node_mo |
| integration_wiring | Vitest coverage config scans correct directories | covered | vitest.config.ts excludes node_modules/, dist/, coverage/, *.config.* — correct  |
| integration_wiring | Dockerfile installs all required runtime dependencies | covered | Dockerfile RUN pnpm add installs all 13 runtime deps matching the adapter import |
| integration_wiring | Fastify core plugins installed | partial | plugins/index.ts imports @fastify/helmet, @fastify/cors, @fastify/rate-limit, @f |
| integration_wiring | AI rate limit configurable via environment | missing | rate-limit.ts:11 hardcodes AI_MAX=10, AI_WINDOW='1 minute'. Global limit is conf |

## Corrective Tasks

1. **Fix: Health readiness probe checks Firestore and GCS**: Pass adapter instances to the health plugin. This requires either: (1) changing registerPlugins to accept deps and passing firestore/gcs, or (2) decorating adapters on the app instance and reading them in the health plugin. The composition root already exposes firestore and gcs on AppDependencies.
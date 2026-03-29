# Test Plan — PRD -- Muesli: Open-Source Meeting Intelligence API v1

## Firebase Auth JWT verification middleware

**What to test:** onRequest hook extracts Bearer token from Authorization header, calls verifyIdToken(), attaches userId (sub) and email to request. Rejects missing/expired/revoked/malformed tokens with 401.


**How to test:** Use fastify.inject() with buildTestApp(). Mock the firebase-admin adapter (vi.mock('../src/adapters/firebase-admin.js')). Test valid token → 200, missing header → 401, expired → 401, revoked → 401, invalid → 401. Verify userId/email are attached to request context.


**Edge cases:**
- Token with valid signature but expired (auth/id-token-expired)
- Token revoked server-side (auth/id-token-revoked with checkRevoked=true)
- Malformed Bearer header (e.g., "Bearer ", "Token xyz", no space)
- Firebase Admin SDK network failure fetching public keys → 503 not 401
- Token from wrong Firebase project (audience mismatch)
- Custom claims present on token (e.g., admin role) — verify passthrough

**Mocking:** Mock firebaseAuth adapter: mockVerifyIdToken resolves with DecodedIdToken fixture or rejects with Firebase error codes. Use vi.hoisted() for mock fns. Standard fixture: { uid, aud, email, email_verified, exp, iat, iss, sub, firebase: { identities, sign_in_provider } }.



## Internal route OIDC authentication (/internal/*)

**What to test:** Pub/Sub push endpoints verify OIDC token from Authorization header. Token audience and service account email must match expected values. Rejects invalid/missing OIDC tokens.


**How to test:** Send POST to /internal/process-audio with mock Pub/Sub envelope. Test with valid OIDC token → 200, missing → 401, wrong audience → 403, wrong service account → 403.


**Edge cases:**
- OIDC token expired
- OIDC token with correct audience but wrong issuer
- Request from non-Pub/Sub source with forged headers

**Mocking:** Mock Google OAuth2 library or custom OIDC verification middleware. Create signed test tokens with known claims for positive cases.



## Share route variable authentication

**What to test:** GET /api/share/:shareId applies auth based on share settings: public shares need no auth, authenticated shares need any valid JWT, specific_emails shares need JWT with matching email.


**How to test:** Create shares with each access mode. Test public → no auth needed, authenticated → valid JWT required, specific_emails → JWT email must match allowedEmails list. Verify 401/403 for each failure case.


**Edge cases:**
- Expired share link (past expiresAt)
- Email case sensitivity in specific_emails check
- Valid JWT but email not in allowedEmails
- Share deleted while being accessed concurrently

**Mocking:** Mock firebaseAuth.verifyIdToken for JWT cases. Mock Firestore to return share documents with different access configurations.



## Health endpoints

**What to test:** GET /health returns 200 { status: "ok", version } without auth. GET /health/ready checks Firestore and GCS connectivity, returns 200 or 503 with { status, checks: { firestore, gcs } }.


**How to test:** Use fastify.inject(). For /health, verify no auth required. For /health/ready, mock Firestore and GCS adapters to simulate healthy and unhealthy states.


**Edge cases:**
- Firestore up but GCS down → 503 with degraded status
- GCS up but Firestore down → 503
- Both down → 503
- Health check during startup (before adapters initialized)

**Mocking:** Mock GCS and Firestore adapters. No auth mock needed for /health.



## Meeting CRUD endpoints

**What to test:** POST /api/meetings (201), GET /api/meetings (pagination, filters), GET /api/meetings/:id (404 for other user's meeting), PUT /api/meetings/:id, DELETE /api/meetings/:id (cascading delete of subcollections + GCS audio).


**How to test:** Use fastify.inject() with mocked auth (valid JWT). Mock Firestore for CRUD operations. Verify userId scoping on all queries. Test pagination (cursor, limit), filtering (date, attendee, tag, status, isStarred), sorting (createdAt, title).


**Edge cases:**
- Create meeting with calendarEventId that doesn't exist
- List with invalid cursor token
- Limit exceeding max (100) → clamped or 400
- Delete meeting that has in-progress transcription
- Update meeting owned by different user → 404 (not 403, to avoid enumeration)
- Meeting status transitions (recording → processing → ready → failed)
- Empty tags array vs missing tags field

**Mocking:** Mock Firestore adapter for document CRUD. Mock GCS adapter for audio deletion on meeting delete. Mock auth middleware with valid DecodedIdToken.



## Input validation (Zod)

**What to test:** All request bodies and query params validated via Zod schemas. Invalid input returns 400 with structured error envelope { error: { code, message, details } }.


**How to test:** Send malformed payloads to each endpoint. Verify 400 response with Zod error details. Test type coercion, missing required fields, extra fields, wrong types, boundary values.


**Edge cases:**
- Empty body where body is required
- Extra unknown fields (should be stripped or rejected per config)
- String where number expected (coercion behavior)
- Array with wrong element types
- Deeply nested invalid data
- Query param with SQL injection attempts (should be harmless)
- XSS payloads in string fields (should be stored safely, not sanitized)

**Mocking:** No mocking needed for validation logic. Use fastify.inject() with various payloads. Mock auth to pass through.



## Rate limiting

**What to test:** 100 req/min on /api/* routes, 10 req/min on AI routes (/api/ai/ask, /api/meetings/:id/notes/generate, /api/ai/meeting-prep). Returns 429 with Retry-After header when exceeded.


**How to test:** Send requests exceeding the limit in a loop. Verify 429 after threshold. Verify Retry-After header. Verify rate limits are per-user (not global).


**Edge cases:**
- Rate limit reset after window expires
- Multiple users hitting same endpoint (isolated counters)
- Rate limit on AI routes vs standard routes (different thresholds)
- Burst at exactly the limit boundary

**Mocking:** Use fake timers to control rate limit windows. Mock auth to provide different userIds. Mock downstream services to avoid real calls.



## WebSocket streaming (WS /api/meetings/:id/stream)

**What to test:** WebSocket upgrade with auth, accepts PCM 16-bit 16kHz mono audio chunks, buffers into 10s segments, writes to GCS, publishes to Pub/Sub, sends back interim transcript JSON frames. On close, finalizes meeting.


**How to test:** Use a WebSocket client (ws package) to connect. Send auth token on upgrade. Send binary audio chunks. Verify interim results are received. Verify meeting finalization on close.


**Edge cases:**
- WebSocket upgrade without valid JWT → 401
- Client disconnects mid-stream → chunks preserved in GCS
- Client reconnects after disconnect
- Invalid audio format (wrong sample rate, wrong bit depth)
- Backpressure when server can't keep up with incoming audio
- Meeting already in "ready" status when stream starts
- Concurrent streams to same meeting

**Mocking:** Mock GCS adapter for chunk storage. Mock Pub/Sub for publish. Mock transcription adapter for interim results. Use real WebSocket connection to a test Fastify instance.



## SSE streaming for transcript results

**What to test:** Server-Sent Events endpoint streams transcript updates to connected clients. Correct Content-Type (text/event-stream), proper event framing, connection cleanup on client disconnect.


**How to test:** Use EventSource (eventsource npm package) for long-lived streams. Use fastify.inject() for finite streams. Verify event format (data:, event:, id: fields).


**Edge cases:**
- Client disconnects mid-stream (verify server cleanup)
- Backpressure from slow client
- Server shutdown while SSE connections are open
- Last-Event-ID reconnection header

**Mocking:** Use real HTTP connection with EventSource. Mock event producers. Use fake timers for interval-based events.



## Graceful shutdown (SIGTERM)

**What to test:** On SIGTERM, server stops accepting new connections, drains in-flight requests, closes WebSocket/SSE connections, completes within 10s (Cloud Run budget).


**How to test:** Start Fastify with listen(), open SSE/WS connections, call fastify.close() or send SIGTERM. Verify connections are closed gracefully. Measure shutdown time.


**Edge cases:**
- Long-running request during shutdown (should complete or timeout)
- WebSocket stream in progress during shutdown
- forceCloseConnections interaction with preClose hooks
- PID 1 signal handling in distroless (no init system)

**Mocking:** Call fastify.close() directly. For PID 1 testing, run actual Docker container and send SIGTERM.



## Audio file upload (POST /api/meetings/:id/audio)

**What to test:** Multipart upload accepts webm, wav, mp3, ogg, m4a, flac. Max 500MB. Stores to GCS at audio/{userId}/{meetingId}/. Returns 202. Publishes to Pub/Sub audio-processing topic.


**How to test:** Use fastify.inject() with multipart form data. Test each supported format. Verify GCS adapter called with correct path. Verify Pub/Sub message published. Verify 202 response.


**Edge cases:**
- Unsupported audio format → 400 with supported formats list
- File exceeding 500MB → 413
- Empty file upload
- Corrupted audio file (valid MIME type, invalid content)
- Upload to meeting owned by different user → 404
- Upload to meeting already in "ready" status
- Concurrent uploads to same meeting

**Mocking:** Mock GCS adapter for storage. Mock Pub/Sub client for publish. Use small test audio fixtures (not real 500MB files).



## Audio playback (GET /api/meetings/:id/audio)

**What to test:** Returns a signed GCS URL with 1-hour expiry. URL is valid and accessible. Returns 404 if no audio exists.


**How to test:** Mock GCS adapter's getSignedUrl to return a test URL. Verify response contains the URL. Verify expiry is set to 1 hour.


**Edge cases:**
- Meeting exists but no audio uploaded yet → 404
- Signed URL generation fails (GCS error) → 503
- Multiple audio files for same meeting (which one?)

**Mocking:** Mock GCS file.getSignedUrl(). Verify called with { version: 'v4', action: 'read', expires: ~1hr }.



## Transcription adapter — Deepgram

**What to test:** Deepgram Nova-2 adapter processes audio via @deepgram/sdk. Returns segments with speaker labels, timestamps, confidence scores. Supports both streaming (WebSocket) and batch modes.


**How to test:** Mock @deepgram/sdk. Verify correct model (nova-2) and options (diarize, smart_format, punctuate, utterances). Verify segment extraction from response. Test streaming mode with mock WS.


**Edge cases:**
- Deepgram API rate limit (429) → retry with backoff
- Deepgram API timeout → retry then fail
- Empty transcript (silence audio)
- Very long audio (> 1hr) — verify chunking/batching
- Confidence scores below threshold

**Mocking:** Mock @deepgram/sdk module. Return fixture responses matching Deepgram's response shape. For streaming, mock WebSocket events.



## Transcription adapter — Self-hosted Whisper

**What to test:** Calls WHISPER_ENDPOINT with audio, receives JSON transcript. Calls DIARIZATION_ENDPOINT separately for speaker labels. Batch only, no streaming support.


**How to test:** Mock HTTP calls to WHISPER_ENDPOINT and DIARIZATION_ENDPOINT. Verify audio is sent correctly. Verify transcript + diarization are merged into segments.


**Edge cases:**
- WHISPER_ENDPOINT set but DIARIZATION_ENDPOINT missing → clear error
- Whisper endpoint returns unexpected format
- Diarization endpoint timeout while transcript succeeds
- Whisper endpoint unreachable → retry 3x then fail

**Mocking:** Mock fetch/http calls to configurable endpoints. Return test fixtures matching expected Whisper/pyannote response formats.



## Transcription adapter — Google Speech-to-Text

**What to test:** Uses @google-cloud/speech v2 Chirp model with built-in diarization. Supports streaming via gRPC.


**How to test:** Mock @google-cloud/speech client. Verify Chirp model selected. Verify diarization config. Test streaming with mock gRPC stream.


**Edge cases:**
- gRPC stream error mid-transcription
- Audio exceeds Google STT limits
- Chirp model not available in region

**Mocking:** Mock @google-cloud/speech SpeechClient. Return fixture responses. For streaming, mock the gRPC stream with EventEmitter.



## Backend selection and per-request override

**What to test:** Default backend from user preferences. Override via ?backend=deepgram|whisper|google-stt query parameter. Invalid backend → 400.


**How to test:** Call transcription with each backend option. Verify correct adapter is invoked. Test override takes precedence over preference.


**Edge cases:**
- Unknown backend name → 400
- Whisper backend selected but WHISPER_ENDPOINT not configured → 400/503
- User preference set to whisper but endpoint removed after config

**Mocking:** Mock all three adapters. Verify only the selected one is called.



## Note generation pipeline (POST /api/meetings/:id/notes/generate)

**What to test:** Loads transcript segments + user notes + template. Builds prompt with [MM:SS] Speaker: text format. Calls Claude API. Parses sections. Extracts action items. Generates embeddings. Saves with version number.


**How to test:** Mock Firestore for transcript/notes/template loading. Mock Anthropic SDK for Claude call. Mock embedding adapter. Verify prompt construction, response parsing, action item extraction, version increment.


**Edge cases:**
- Empty transcript (no segments) → should still generate from user notes
- No user notes → generate from transcript only
- Template with sections Claude can't fill → empty sections
- Claude API failure → retry 2x, return partial results
- Very long transcript (token limit) → truncation strategy
- Concurrent generation requests for same meeting
- Regeneration with different template preserves previous versions
- User has manually edited current notes → warn on regeneration

**Mocking:** Mock Anthropic SDK: return structured note content matching template sections. Mock Firestore for all document reads/writes. Mock embedding endpoint for vector generation.



## Cross-meeting AI Q&A (POST /api/ai/ask)

**What to test:** RAG pipeline: embed question → retrieve top-20 chunks → apply filters → build Claude prompt with context → generate answer with citations referencing meetings + timestamps.


**How to test:** Mock embedding adapter for question embedding. Mock vector similarity search (Firestore). Mock Claude API for answer generation. Verify citations reference real meeting IDs.


**Edge cases:**
- No relevant meetings found → appropriate "no results" response
- All retrieved chunks from same meeting
- Filters exclude all results
- Question about meeting user doesn't own (shouldn't match)
- Rate limit (10 req/min) enforcement
- Claude API failure → graceful error

**Mocking:** Mock embedding adapter, Firestore vector queries, and Anthropic SDK. Use fixture chunks with known meeting IDs for citation verification.



## Meeting prep (POST /api/ai/meeting-prep)

**What to test:** Accepts calendarEventId or attendees list. Finds past meetings with overlapping attendees. Generates prep brief with previous topics, open action items, relationship context, talking points.


**How to test:** Mock Firestore for meeting history queries. Mock Claude API for brief generation. Verify attendee matching logic.


**Edge cases:**
- No previous meetings with attendees → minimal prep
- Calendar event with no attendees
- Large number of past meetings (top-N selection)

**Mocking:** Mock Firestore queries and Anthropic SDK.



## Audit logging for AI operations

**What to test:** All Claude API calls logged with model, tokens, latency, cost. No PII (transcript content, user notes, emails) in logs.


**How to test:** Intercept structured log output after AI operations. Verify required fields present. Verify no PII leakage via log content scanning.


**Edge cases:**
- Failed AI call still logs attempt with error info
- Streaming response token counting
- Cost calculation accuracy

**Mocking:** Mock Anthropic SDK. Capture log output via Pino destination override or spy on logger methods.



## Meeting template CRUD

**What to test:** 7 built-in system templates seeded on first run (read-only). Custom template create/read/update/delete. System templates return 403 on update/delete.


**How to test:** Use fastify.inject() for all template endpoints. Verify system templates returned in GET /api/templates. Verify CRUD on custom templates. Verify 403 on PUT/DELETE of system templates.


**Edge cases:**
- Create template with duplicate name (allowed? unique constraint?)
- Delete template that is a user's defaultTemplateId
- Template with empty sections array
- Template with very long prompt text per section
- System template seeding idempotency (run twice, still 7)

**Mocking:** Mock Firestore for template document CRUD. Seed mock data for system templates.



## User notes ingestion

**What to test:** POST /api/meetings/:id/user-notes stores text as transcript segment with isUserNote: true. Timestamp defaults to now minus startedAt. GET returns all user notes for meeting.


**How to test:** Use fastify.inject(). Verify segment created with correct fields. Verify timestamp calculation. Verify retrieval ordered by time.


**Edge cases:**
- Note with explicit timestamp vs default
- Note to meeting that hasn't started yet
- Very long note text
- Unicode/emoji in note text
- Note to meeting owned by different user → 404

**Mocking:** Mock Firestore for segment writes/reads. Mock auth middleware.



## Full-text search

**What to test:** GET /api/search?q=...&type= searches across meetings, notes, actions, all. Cursor-based pagination. Filters: dateFrom, dateTo, attendee, tag, status, isStarred.


**How to test:** Mock Firestore queries. Verify search returns matches across entity types. Verify pagination cursors. Verify filter application. Verify < 500ms performance constraint.


**Edge cases:**
- Empty query string
- Query with special characters
- No results → empty array with cursor
- Type filter narrows correctly
- Search only returns user's own data (userId scoping)

**Mocking:** Mock Firestore query results. Return fixture documents matching search criteria.



## Semantic search

**What to test:** GET /api/search/semantic?q= generates embedding for query, performs vector similarity search, returns ranked results with cosine similarity and snippet highlighting.


**How to test:** Mock embedding adapter for query embedding. Mock Firestore vector search. Verify results are ranked by similarity. Verify < 2s performance constraint.


**Edge cases:**
- No embeddings generated yet (new deployment) → graceful degradation
- Query embedding fails → fallback to full-text or error
- All results below similarity threshold

**Mocking:** Mock embedding adapter and Firestore vector queries. Use fixture embeddings with known similarity scores.



## Action item CRUD and tracking

**What to test:** GET /api/actions (filterable), GET /api/actions/summary (dashboard), GET /api/meetings/:id/actions, POST/PUT/DELETE /api/actions/:id. Auto-extraction during note generation. Manual creation.


**How to test:** Use fastify.inject(). Test each endpoint. Verify summary aggregation (open, overdue, due this week, by assignee). Verify status transitions (open → in_progress → completed/cancelled).


**Edge cases:**
- Action item with past due date (overdue calculation)
- Action item with no assignee
- Delete action item from AI-extracted source
- Action items across multiple meetings for same assignee
- Timezone handling for due dates

**Mocking:** Mock Firestore for action item documents. Use fixture data with various statuses, assignees, and due dates.



## Google Calendar OAuth2 flow

**What to test:** POST /api/calendar/connect initiates OAuth2 flow. GET callback completes it. DELETE disconnects. Token storage and refresh.


**How to test:** Mock Google OAuth2 client. Verify redirect URL generation. Verify token exchange on callback. Verify token storage in Firestore. Verify revocation on disconnect.


**Edge cases:**
- OAuth callback with invalid state parameter
- Token exchange failure
- Double-connect (already connected)
- Disconnect when already disconnected

**Mocking:** Mock Google OAuth2 client for all token operations. Mock Firestore for token storage.



## Calendar sync and auto-meeting creation

**What to test:** POST /api/calendar/sync does incremental sync via sync tokens. Periodic sync (every 5 min) creates meeting records from calendar events. Attendee resolution against known users.


**How to test:** Mock Google Calendar API. Verify sync token handling. Verify meeting creation from calendar events. Verify attendee email matching.


**Edge cases:**
- Sync token expired → full sync fallback
- Calendar event updated after meeting created
- Calendar event deleted → meeting status update?
- Event with no attendees
- OAuth token expired during sync → auto-refresh, then disconnect on failure

**Mocking:** Mock Google Calendar API responses with fixture events. Mock Firestore for meeting creation and user lookup.



## Shareable meeting note links

**What to test:** POST /api/meetings/:id/share creates link with access mode (public/authenticated/specific_emails). GET /api/share/:shareId returns notes. View count incremented. Expiry enforced. Revocation.


**How to test:** Create shares with each access mode. Verify GET returns correct data. Verify view count increments. Verify expired shares return 404. Verify DELETE revokes.


**Edge cases:**
- Public share includes title, date, attendee names but NOT emails
- includeTranscript/includeAudio flags respected
- Share with expiresAt in the past → 404
- Concurrent access incrementing view count (race condition)
- Share for meeting user doesn't own → 404
- Multiple active shares for same meeting

**Mocking:** Mock Firestore for share documents. Mock auth adapter for access verification. Mock GCS for audio URL if includeAudio.



## User profile and preferences

**What to test:** GET /api/me returns profile + preferences. PUT /api/me updates preferences. DELETE /api/me deletes account + all data (GDPR).


**How to test:** Use fastify.inject(). Verify preference fields (defaultTemplateId, transcriptionBackend, autoTranscribe, timezone, language). Verify DELETE cascades all user data.


**Edge cases:**
- DELETE /api/me with active meetings in processing state
- Set defaultTemplateId to non-existent template
- Set transcriptionBackend to whisper when endpoint not configured
- Invalid timezone or language code

**Mocking:** Mock Firestore for user document CRUD. For DELETE, verify all subcollections and GCS paths are cleaned up.



## Audio processing pipeline (/internal/process-audio)

**What to test:** Push subscriber receives Pub/Sub message. Downloads audio from GCS. Calls transcription adapter. Writes transcript segments (batch writes). Calculates speaker stats. Triggers note generation if autoTranscribe. Updates meeting status.


**How to test:** Send mock Pub/Sub push message to /internal/process-audio. Verify each pipeline step executes. Verify meeting status transitions (processing → ready or failed).


**Edge cases:**
- Audio file missing from GCS → fail with clear error
- Transcription adapter failure → retry 3x with backoff
- Partial transcript (adapter returns some segments then fails)
- Dead-letter after 3 failed attempts
- Duplicate message delivery (idempotency)
- Very large transcript (batch write limits in Firestore)
- Meeting deleted while processing is in-flight

**Mocking:** Mock GCS adapter for download. Mock transcription adapter. Mock Firestore for writes. Send Pub/Sub envelope as HTTP POST with base64-encoded data.



## GCS adapter operations

**What to test:** Upload audio to audio/{userId}/{meetingId}/ path. Generate signed URLs for read (1hr expiry) and write. Delete audio files on meeting deletion. Stream upload for WebSocket chunks.


**How to test:** Unit test GCS adapter with mocked @google-cloud/storage. Verify correct bucket/path construction. Verify signed URL parameters. Verify delete with ignoreNotFound.


**Edge cases:**
- Upload stream error mid-transfer
- Signed URL generation with special characters in object name
- {'Delete non-existent file (ignoreNotFound': 'true)'}
- Concurrent writes to same path
- GCS unavailable → retry 3x then 503

**Mocking:** Mock @google-cloud/storage module with vi.mock(). Use vi.hoisted() for mock functions. Mock createWriteStream returning a Writable stream. Mock getSignedUrl returning fixture URLs.



## Embedding generation and storage

**What to test:** After note generation, split notes + transcript into ~500-token chunks. Embed via Vertex AI text-embedding-004 (or configurable EMBEDDING_ENDPOINT). Store embeddings in Firestore for vector search.


**How to test:** Mock @google/genai SDK. Verify chunk splitting logic. Verify embeddings stored with correct dimensions. Verify batch embedding call.


**Edge cases:**
- Embedding endpoint failure → non-blocking, notes still available
- Empty chunk (short meeting)
- Chunk count exceeds batch limit
- Model mismatch (can't compare embeddings from different models)
- EMBEDDING_ENDPOINT override vs Vertex AI default

**Mocking:** Mock @google/genai embedContent(). Return fixture arrays of correct dimensionality (768 for text-embedding-004).



## Secret and environment variable loading

**What to test:** Required secrets (ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, FIREBASE_SERVICE_ACCOUNT, GCS_BUCKET, GOOGLE_CLOUD_PROJECT) loaded from env vars. Optional secrets gracefully handled when absent. App fails fast with clear error when required secrets missing.


**How to test:** Set/unset process.env values. Verify startup fails with descriptive error for missing required secrets. Verify optional secrets default correctly.


**Edge cases:**
- FIREBASE_SERVICE_ACCOUNT as JSON string (not file path)
- Secret value with special characters (=, newlines, quotes)
- GCS_BUCKET set to empty string vs not set
- All optional vars omitted → Deepgram default, Vertex AI embeddings
- Env vars with trailing whitespace

**Mocking:** Manipulate process.env directly in tests. Save/restore original env in beforeEach/afterEach.



## Dockerfile multi-stage build

**What to test:** Produces valid minimal image. Build stage with pnpm + corepack. Runtime stage with distroless. No dev deps, no pnpm store, no source .ts files in final image. Runs as non-root.


**How to test:** Build Docker image. Inspect layers. Verify final image size (< 500MB). Run vulnerability scan (trivy/grype). Verify non-root user. Verify no shell in distroless.


**Edge cases:**
- pnpm-lock.yaml out of sync → --frozen-lockfile fails
- Missing packageManager field in package.json
- .dockerignore misconfigured → node_modules or .env leaks into context
- BuildKit cache mount unavailable (DOCKER_BUILDKIT=0) → still builds
- Node version mismatch between build and runtime stages

**Mocking:** No mocking — real Docker builds. Inspect actual image.



## Container startup and Cloud Run compatibility

**What to test:** Container binds to $PORT (default 8080). GET /health returns 200 within startup probe timeout. Handles concurrent requests. Graceful shutdown within 10s SIGTERM budget. 3600s timeout for WebSocket.


**How to test:** Run container with docker run. Verify health endpoint. Send SIGTERM and measure shutdown time. Test with --memory and --cpus flags to simulate Cloud Run constraints.


**Edge cases:**
- PORT env var not set → default to 8080
- Container starts with missing required secrets → fail fast
- SIGTERM → SIGKILL after 10s budget
- Memory limit (512MB default) → no OOM under normal load
- Container filesystem read-only except /tmp
- Application shells out → fails silently in distroless
- DNS resolution in distroless

**Mocking:** Use emulators for GCP services via docker-compose. Test real container behavior. Use docker run resource limits.



## Docker Compose local development stack

**What to test:** docker-compose up starts API + all emulators (Firebase, Firestore, GCS, Pub/Sub). API can reach all emulators. Health endpoints respond.


**How to test:** Run docker-compose up. Hit /health and /health/ready. Verify API reaches each emulator. Verify clean teardown.


**Edge cases:**
- Emulator ports already in use on host
- API starts before emulators ready → depends_on with healthcheck
- docker-compose down --volumes cleans all state
- Restarting only API while emulators keep running

**Mocking:** Uses real emulators (firebase-emulator, fake-gcs-server, pubsub-emulator) — no mocking needed.



## E2E: Upload audio → transcribe → generate notes → search

**What to test:** Full meeting lifecycle: create meeting → upload audio → Pub/Sub processes audio → transcription completes → auto-generate notes → embeddings created → meeting searchable via full-text and semantic.


**How to test:** Integration test with emulators. Create meeting via API. Upload audio. Simulate Pub/Sub push to /internal/process-audio. Verify transcript segments written. Trigger note generation. Verify notes saved. Query search endpoints for meeting content.


**Edge cases:**
- Transcription fails mid-pipeline → meeting status "failed", search excluded
- Note generation fails but transcript succeeds → partial data searchable
- Embedding generation fails → notes available but semantic search degraded

**Mocking:** Mock only external APIs (Anthropic, Deepgram). Use emulators for Firestore, GCS, Pub/Sub. Real Fastify app instance.



## E2E: Auth → CRUD → share → access

**What to test:** User authenticates → creates meeting → adds notes → generates notes → creates public share → unauthenticated user accesses share → verify no PII (emails) in shared response.


**How to test:** Integration test with two "users" — one authenticated, one not. Verify the complete sharing flow including access control and data filtering.


**Edge cases:**
- Share with specific_emails — second user has matching email
- Share link accessed after meeting is deleted
- Share expiry during active viewing session

**Mocking:** Mock Firebase Auth (two different tokens). Mock Anthropic SDK. Use Firestore emulator for real data flow.



## E2E: Calendar sync → auto-create meeting → upload → notes

**What to test:** Calendar sync detects event → auto-creates meeting with title, attendees, description → user uploads audio → transcription resolves speaker labels to calendar attendees → notes generated with correct speaker names.


**How to test:** Mock Calendar API with fixture events. Trigger sync. Verify meeting created with calendar metadata. Proceed through audio upload and note generation. Verify speaker resolution uses attendee list.


**Edge cases:**
- Calendar attendee email doesn't match any known user
- Meeting manually created then calendar event arrives (dedup)
- Calendar token expires during sync → auto-refresh

**Mocking:** Mock Google Calendar API. Mock transcription adapter. Mock Anthropic SDK. Use Firestore emulator.



## E2E: WebSocket stream → real-time transcription → interim results

**What to test:** Client opens WS with auth → streams audio chunks → server buffers segments → Pub/Sub processes each → transcription adapter returns interim results → client receives JSON frames → client disconnects → meeting finalized → notes generated.


**How to test:** Use ws client to connect. Send fixture audio chunks. Verify GCS writes for each segment. Verify Pub/Sub messages published. Mock transcription adapter returning interim results. Verify client receives them. Close WS. Verify meeting finalized.


**Edge cases:**
- Client disconnects unexpectedly mid-stream
- Network latency causes backpressure
- Multiple concurrent WebSocket streams (different meetings)

**Mocking:** Real WS connection to test Fastify instance. Mock GCS, Pub/Sub, and transcription adapter. Mock auth.



## E2E: Action items across meetings → Q&A references

**What to test:** Multiple meetings generate action items. Cross-meeting Q&A (POST /api/ai/ask) can find and reference action items from different meetings. Action summary aggregates across meetings.


**How to test:** Create 3+ meetings with notes containing action items. Query /api/ai/ask about "open action items with Alice". Verify citations reference correct meetings. Check /api/actions/summary.


**Edge cases:**
- Action items with same assignee across meetings
- Action item completed in one meeting, referenced in another
- Overdue action items surface in meeting prep

**Mocking:** Mock Anthropic SDK for Q&A response. Mock embedding adapter. Use Firestore emulator with pre-seeded meeting data.



## E2E: GDPR account deletion cascading cleanup

**What to test:** DELETE /api/me removes user document, all meetings, all transcripts, all notes, all action items, all shares, all embeddings, all audio from GCS, all calendar tokens.


**How to test:** Create user with multiple meetings, notes, shares, actions. Call DELETE /api/me. Verify all Firestore documents removed. Verify GCS audio paths deleted. Verify no orphaned data.


**Edge cases:**
- Deletion while async processing is in-flight
- Deletion with active shares (should be revoked)
- GCS deletion partially fails (some files, not all)

**Mocking:** Use Firestore emulator with real data. Mock GCS adapter. Verify all cleanup calls made.



## Integration: userId scoping across all domains

**What to test:** Every Firestore query includes userId filter. User A cannot access User B's meetings, notes, actions, templates (custom), or shares. Consistent 404 (not 403) for unauthorized access.


**How to test:** Create data as User A. Attempt access as User B on every endpoint. Verify 404 on all. Verify no data leakage in list endpoints (GET /api/meetings returns only own data).


**Edge cases:**
- User B guesses valid meeting ID → 404
- Share created by User A, User B accesses (legitimate access)
- System templates visible to all users (not scoped)

**Mocking:** Mock auth adapter to return different UIDs. Use Firestore emulator with data from multiple users.



## Integration: Error propagation across service boundaries

**What to test:** GCS failure during audio upload → 503 to client. Firestore failure during CRUD → 503. Claude API failure during note gen → partial result or error. Pub/Sub publish failure → 503 on upload.


**How to test:** Mock each external dependency to throw. Verify appropriate HTTP status codes propagate to client. Verify retry behavior where specified. Verify no sensitive error details in response.


**Edge cases:**
- Multiple dependencies fail simultaneously
- Timeout vs connection refused vs auth error (different handling)
- Error during Pub/Sub processing (dead-letter behavior)

**Mocking:** Mock adapters to throw specific error types. Verify HTTP response codes and error envelope format.



## [Smoke] Health check

**What to test:** Verifies the service is running and responsive

**How to test:** Smoke test: GET /health


## [Smoke] Readiness probe

**What to test:** Verifies Firestore and GCS connectivity

**How to test:** Smoke test: GET /health/ready


## [Smoke] Auth gate

**What to test:** Verifies unauthenticated requests are rejected

**How to test:** Smoke test: GET /api/meetings (no Authorization header)


## [Smoke] Meeting lifecycle

**What to test:** Verifies core meeting CRUD happy path

**How to test:** Smoke test: POST /api/meetings with valid JWT → 201, GET /api/meetings → list includes new meeting, GET /api/meetings/:id → returns meeting detail, POST /api/meetings/:id/user-notes → 201, POST /api/meetings/:id/audio with test file → 202, GET /api/meetings/:id/transcript → returns segments (after processing)


## [Smoke] Note generation and retrieval

**What to test:** Verifies AI note generation pipeline produces valid output

**How to test:** Smoke test: Create meeting with transcript segments (seed Firestore), POST /api/meetings/:id/notes/generate → 200, GET /api/meetings/:id/notes/latest → returns structured notes


## [Smoke] Search

**What to test:** Verifies search returns results

**How to test:** Smoke test: Seed meeting with known content, GET /api/search?q=<known term>


## [Smoke] AI Q&A

**What to test:** Verifies cross-meeting Q&A produces answer with citations

**How to test:** Smoke test: Seed multiple meetings with embeddings, POST /api/ai/ask { question }


## [Smoke] Action items

**What to test:** Verifies action item extraction and retrieval

**How to test:** Smoke test: Generate notes (which extracts action items), GET /api/actions


## [Smoke] Sharing flow

**What to test:** Verifies share creation and public access

**How to test:** Smoke test: POST /api/meetings/:id/share { access "public" }, GET /api/share/:shareId (no auth)


## [Smoke] Templates

**What to test:** Verifies built-in templates are seeded and accessible

**How to test:** Smoke test: GET /api/templates


---

# Mocking Strategy

**external_apis:** {'anthropic_claude': "Mock @anthropic-ai/sdk module via vi.mock(). Return fixture responses matching Claude's response shape (content blocks with text). For streaming, mock AsyncIterable. Track calls to verify model selection (Sonnet vs Opus), token counts, and prompt construction. Never call real Claude API in unit/integration tests.\n", 'deepgram': 'Mock @deepgram/sdk module. Return fixture transcription responses with speaker labels, timestamps, and confidence scores. For streaming mode, mock WebSocket events (open, message, close).\n', 'google_calendar': 'Mock Google Calendar API client. Return fixture event lists with sync tokens. Simulate token refresh and revocation scenarios.\n', 'google_speech': 'Mock @google-cloud/speech client. Return fixture recognition responses. For streaming, mock gRPC bidirectional stream.\n', 'whisper_endpoint': 'Mock HTTP calls to WHISPER_ENDPOINT and DIARIZATION_ENDPOINT using vi.fn() or msw (Mock Service Worker). Return fixture transcript and diarization responses.\n'}

**databases:** {'firestore': 'Use Firebase Emulator Suite (FIRESTORE_EMULATOR_HOST). Provides real Firestore behavior without cloud credentials. Reset between tests via emulator REST API (DELETE http://localhost:8080/emulator/v1/projects/test/databases/(default)/documents). For unit tests, mock the Firestore adapter layer instead.\n', 'vector_search': 'Mock Firestore vector queries at the adapter level. Return fixture results with known similarity scores. Verify query includes correct embedding and filters.\n'}

**time:** Use vi.useFakeTimers() for: rate limit window tests, token expiry checks, share link expiration, action item due date calculations, calendar sync intervals. Advance time with vi.advanceTimersByTime(). Restore with vi.useRealTimers() in afterEach. For timestamp-dependent Firestore queries, use deterministic Date values rather than Date.now().


**randomness:** Mock crypto.randomUUID() for deterministic share IDs, meeting IDs, and request IDs in tests. Use vi.spyOn where possible, or inject ID generators via dependency injection. Seed known values for cursor-based pagination tests.


**gcs:** Mock @google-cloud/storage via adapter pattern. Unit tests mock GcsAdapter interface (upload, getSignedUrl, delete). Adapter unit tests mock SDK directly (bucket, file, createWriteStream, getSignedUrl). For integration tests with docker-compose, use fake-gcs-server emulator.


**pubsub:** For unit tests, mock Pub/Sub client publish(). For integration tests, use Pub/Sub emulator (PUBSUB_EMULATOR_HOST). Note: emulator does not support push delivery — simulate push by sending HTTP POST with Pub/Sub envelope format to /internal/* endpoints.


**secrets:** Set process.env directly in tests for secrets injected as env vars. Save/restore process.env in beforeEach/afterEach. No Secret Manager emulator needed — adapter pattern isolates secret access.


**embeddings:** Mock @google/genai embedContent(). Return fixture float arrays of correct dimensionality (768 for text-embedding-004). For cosine similarity tests, use fixture pairs with known similarity scores.


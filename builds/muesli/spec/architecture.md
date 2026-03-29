# Architecture — PRD -- Muesli: Open-Source Meeting Intelligence API v1

## Overview

Muesli is a single-tenant meeting intelligence API built on Fastify (Node 20+, TypeScript). It follows clean architecture with three layers: HTTP/WebSocket routes, service layer (business logic), and adapter layer (external integrations). All external dependencies are accessed through adapter interfaces for testability. Async audio processing uses GCP Pub/Sub push subscriptions to Cloud Run internal endpoints. Calendar sync uses Cloud Scheduler triggering an internal HTTP endpoint every 5 minutes. Vector search uses Firestore's native vector search with HNSW indexes. Full-text search uses Firestore composite indexes with tokenized text stored as array fields.


## Components

### Fastify Server

HTTP/WebSocket server entry point. Registers plugins (auth, rate-limit, multipart, websocket), mounts route plugins, initializes adapters, seeds system templates on first run, handles graceful shutdown with SIGTERM (10s Cloud Run budget).


**API Surface:** Listens on PORT env var (default 8080). Exposes /health, /api/*, /internal/*, /api/share/* routes. WebSocket upgrade at /api/meetings/:id/stream.



### Auth Middleware

Fastify onRequest hook on /api/* routes. Extracts Bearer token from Authorization header, verifies via Firebase Admin SDK verifyIdToken(). Attaches userId and email to request. Internal routes (/internal/*) verify Pub/Sub OIDC tokens. Share routes enforce per-share access rules.


**Dependencies:** Firebase Auth Adapter

**API Surface:** Decorates Fastify request with userId, userEmail.


### Rate Limit Plugin

Two-tier rate limiting via @fastify/rate-limit. Global: 100 req/min per userId on /api/* routes. AI tier: 10 req/min per userId on /api/ai/* routes. In-memory store (single-tenant, single instance). Health and share-public routes excluded.


**API Surface:** Returns 429 with Retry-After header when exceeded.


### Meeting Routes

CRUD for meetings, transcript retrieval, speaker management, note versioning, user note ingestion. Audio upload (multipart) stores to GCS and publishes to Pub/Sub. Audio playback returns signed GCS URL.


**Dependencies:** Meeting Service

**API Surface:** /api/meetings/*, /api/meetings/:id/audio, /api/meetings/:id/transcript, /api/meetings/:id/notes/*, /api/meetings/:id/user-notes, /api/meetings/:id/speakers/*


### WebSocket Stream Handler

Accepts live PCM audio via WebSocket at /api/meetings/:id/stream. Buffers 10-second segments, writes chunks to GCS, publishes each segment to Pub/Sub for transcription. Sends interim transcript JSON frames back to client. On close, finalizes meeting and triggers full processing pipeline.


**Dependencies:** Meeting Service, GCS Adapter, Pub/Sub Adapter, Transcription Adapter (for streaming backends)

**API Surface:** WS /api/meetings/:id/stream


### Template Routes

CRUD for meeting templates. System templates are read-only (403 on mutation). Custom templates scoped to userId.

**Dependencies:** Template Service

**API Surface:** /api/templates, /api/templates/:id


### Action Routes

CRUD for action items. Summary endpoint with grouping. Filterable by status, assignee, meeting, due date.

**Dependencies:** Action Service

**API Surface:** /api/actions, /api/actions/summary, /api/actions/:id, /api/meetings/:id/actions


### Search Routes

Full-text search using tokenized text arrays in Firestore (array-contains-any on search_tokens field). Semantic search generates query embedding via Embedding Adapter, performs Firestore vector nearest-neighbor query on stored embeddings. Both support filters and cursor-based pagination.


**Dependencies:** Search Service, Embedding Adapter

**API Surface:** /api/search, /api/search/semantic


### AI Routes

Cross-meeting Q&A via RAG pipeline (embed question → vector search top-20 chunks → build Claude prompt with cited context → return answer with meeting citations). Meeting prep finds past meetings by attendee overlap, generates prep brief. Note generation endpoint triggers the full pipeline.


**Dependencies:** AI Service, Claude Adapter, Embedding Adapter

**API Surface:** /api/ai/ask, /api/ai/meeting-prep, /api/meetings/:id/notes/generate


### Calendar Routes

Google Calendar OAuth2 connect/disconnect flow. Event listing. Incremental sync via sync tokens. Stores OAuth tokens encrypted in Firestore under user document.


**Dependencies:** Calendar Service, Google Calendar Adapter

**API Surface:** /api/calendar/connect, /api/calendar/callback, /api/calendar/events, /api/calendar/sync, /api/calendar/disconnect


### Share Routes

Create/revoke shareable links with access control (public, authenticated, specific_emails). Public share endpoint at /api/share/:shareId requires no auth for public shares. Tracks view count. Respects expiration.


**Dependencies:** Share Service

**API Surface:** /api/meetings/:id/share, /api/meetings/:id/shares, /api/share/:shareId


### User Routes

Profile and preferences management. Account deletion (GDPR) cascades to all user data.

**Dependencies:** User Service

**API Surface:** /api/me


### Audio Processing Worker

Internal Pub/Sub push handler. Downloads audio from GCS, calls transcription adapter, writes transcript segments to Firestore in batches, calculates speaker stats, optionally triggers note generation if autoTranscribe is enabled, updates meeting status.


**Dependencies:** Transcription Adapter, GCS Adapter, Firestore Adapter, AI Service

**API Surface:** POST /internal/process-audio (Pub/Sub push endpoint, OIDC-authenticated)


### Calendar Sync Worker

Internal endpoint triggered by Cloud Scheduler every 5 minutes. Iterates users with connected calendars, performs incremental sync, creates meeting records for upcoming/started events.


**Dependencies:** Calendar Service

**API Surface:** POST /internal/calendar-sync (Cloud Scheduler, OIDC-authenticated)


### Transcription Adapter

Adapter interface with three implementations: Deepgram (default, uses @deepgram/sdk Nova-2), Whisper (HTTP POST to WHISPER_ENDPOINT + DIARIZATION_ENDPOINT), Google STT (@google-cloud/speech v2 Chirp). All return unified TranscriptSegment[] format. Backend selected per-user preference or per-request override.


**API Surface:** transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptSegment[]>


### Claude Adapter

Wraps Anthropic SDK. Handles note generation prompts, Q&A prompts, meeting prep prompts. Logs all calls with model, tokens, latency, estimated cost. Supports Sonnet (default) and Opus. Implements retry (2x) with graceful degradation.


**API Surface:** generate(prompt: string, options: ClaudeOptions): Promise<ClaudeResponse>


### Embedding Adapter

Pluggable embedding generation. Default: Vertex AI text-embedding-004 via @google/genai SDK. Fallback: configurable EMBEDDING_ENDPOINT for self-hosted. Chunks text into ~500-token segments. Non-blocking — failures degrade semantic search but don't block note saving.


**API Surface:** embed(texts: string[]): Promise<number[][]>


### Firestore Adapter

Thin wrapper around Firebase Admin Firestore SDK. All queries include userId scope. Provides typed collection accessors. Handles batch writes for transcript segments. Stores vector embeddings using Firestore's native vector field type.


**API Surface:** Collection-scoped CRUD methods, batch write support, vector nearest-neighbor queries.


### GCS Adapter

Wraps @google-cloud/storage. Uploads audio to audio/{userId}/{meetingId}/ path. Generates signed download URLs (1-hour expiry) via signBlob (no JSON key needed on Cloud Run). Deletes audio on meeting deletion. Supports streaming writes for WebSocket chunks.


**API Surface:** upload, getSignedUrl, delete, createWriteStream


### Pub/Sub Adapter

Publishes messages to audio-processing topic. Wraps @google-cloud/pubsub. Message payload includes meetingId, userId, audioPath, backend preference.


**API Surface:** publish(topic: string, data: object): Promise<string>


## Integration Points

- **Firebase Auth** (rest, inbound)
  - Failure mode: JWT verification uses cached public keys (SDK handles caching via Cache-Control max-age ~6hrs). Network failure to fetch keys on cold start: return 503, retry on next request. Token verification is local after first key fetch — no ongoing network dependency.

- **Google Cloud Storage** (rest, outbound)
  - Failure mode: Retry 3x with exponential backoff (SDK default). On exhaustion, return 503. Audio chunks already in GCS are preserved on failure.
- **Google Cloud Pub/Sub** (rest, outbound)
  - Failure mode: Retry 3x. If publish fails, return 503 to client (audio upload not accepted). Push delivery retries 3x with exponential backoff (10s-600s), then dead-letter topic.
- **Deepgram API** (rest, outbound)
  - Failure mode: Retry 3x with backoff. On exhaustion, mark meeting as failed with error details.
- **Whisper Endpoint** (rest, outbound)
  - Failure mode: Retry 3x. Missing endpoint config returns clear 400 error. On exhaustion, mark meeting failed.
- **Google Speech-to-Text** (grpc, outbound)
  - Failure mode: Retry 3x with backoff. On exhaustion, mark meeting failed.
- **Anthropic Claude API** (rest, outbound)
  - Failure mode: Retry 2x. On failure, return partial results (transcript without notes). Queue retry via meeting status remaining in processing state.
- **Vertex AI Embeddings** (rest, outbound)
  - Failure mode: Non-blocking. On failure, notes are saved without embeddings. Semantic search returns degraded results. Log warning. Can be retried manually via note regeneration.
- **Google Calendar API** (rest, outbound)
  - Failure mode: Auto-refresh expired tokens. If refresh fails, mark calendar as disconnected, log event. Sync continues for other users.
- **Cloud Scheduler** (rest, inbound)
  - Failure mode: Missed sync is non-critical — next invocation in 5 minutes catches up via sync tokens. Cloud Scheduler retries failed invocations automatically.

## Deployment

- **local:** docker-compose with: Muesli API container (Node 20, built with pnpm + distroless multi-stage), Firebase Emulator (auth + firestore), GCS emulator (fake-gcs-server or similar), Pub/Sub emulator. Environment variables point to emulator endpoints. WHISPER_ENDPOINT and EMBEDDING_ENDPOINT optional for local.

- **ci:** GitHub Actions. Build Docker image, run vitest unit + integration tests against emulators. Smoke test: build image, start with docker-compose, hit /health and key endpoints. No real GCP resources in CI — all mocked or emulated.

- **production:** Single Docker image deployed to GCP Cloud Run. Min instances: 1 (avoid cold starts for WebSocket). Max instances: configurable (default 10). Instance-based billing (cpu-always-allocated) for WebSocket and background processing support. Secrets via GCP Secret Manager env var injection. Cloud Scheduler triggers /internal/calendar-sync every 5 minutes. Pub/Sub push subscription delivers to /internal/process-audio with OIDC auth. Startup probe: GET /health. Liveness probe: GET /health. Timeout: 3600s (for WebSocket).


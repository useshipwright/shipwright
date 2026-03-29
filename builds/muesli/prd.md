# PRD -- Muesli: Open-Source Meeting Intelligence API v1

Owner: Luke
Last updated: 2026-03-27
Status: Draft (ready for build)

---

## 1) Summary

Build the backend API for **Muesli**, an open-source alternative to Granola.ai ($2B valuation). Muesli is a meeting intelligence service that accepts audio (file upload or WebSocket streaming), transcribes with speaker diarization via pluggable backends, merges transcripts with user-typed notes, and produces structured meeting notes using customizable templates powered by Claude.

The service also provides a searchable meeting library, cross-meeting AI Q&A, action item tracking, Google Calendar integration, and shareable meeting note links.

All business logic is server-side. Desktop/web clients are consumers of this API. Designed for self-hosting: a single Docker image with pluggable transcription (Deepgram cloud or self-hosted Whisper endpoint).

---

## 2) Goals

- Accept audio via file upload (post-meeting) or WebSocket streaming (real-time)
- Transcribe audio with speaker diarization using pluggable backends (Deepgram, self-hosted Whisper, Google Speech-to-Text)
- Merge user-typed meeting notes with AI-generated transcripts to produce structured notes
- Support customizable note templates (1:1, standup, sales call, retrospective, interview, custom)
- Extract action items, decisions, and key topics automatically
- Provide full-text and semantic search across all meetings
- Enable cross-meeting AI Q&A via RAG over meeting history
- Integrate with Google Calendar for automatic meeting context
- Support shareable meeting note links (public or authenticated)
- Track action items with assignees and due dates across meetings
- Expose a comprehensive REST + WebSocket API for any frontend
- Firebase Auth JWT on all API routes
- Structured audit logging for all AI operations (model, tokens, cost)

---

## 3) Non-Goals (v1)

- Desktop app, browser extension, or any frontend (backend API only)
- System audio capture (desktop client concern)
- Meeting bot that joins Zoom/Meet/Teams calls
- Multi-tenant SaaS (single-tenant self-hosted)
- Video recording or screen capture
- Billing or subscription management
- Slack or Microsoft Teams integration
- End-to-end encryption
- Mobile app
- Real-time collaborative note editing

---

## 4) Target Environment

- Deploy target: GCP Cloud Run
- Secrets: GCP Secret Manager
- Runtime: TypeScript (Node 20+), package manager pnpm
- Framework: Fastify
- Database: Firebase Firestore
- File Storage: Google Cloud Storage (audio files)
- Async Processing: Google Cloud Pub/Sub
- Auth: Firebase Auth (JWT verification)

---

## 5) Capabilities

### CAP-1: Audio Ingestion

Accept audio via two modes:

**File upload:** `POST /api/meetings/{id}/audio` accepts multipart upload (webm, wav, mp3, ogg, m4a, flac). Max 500MB. Stores to GCS at `audio/{userId}/{meetingId}/`. Returns 202 and publishes to Pub/Sub for async transcription.

**WebSocket streaming:** `WS /api/meetings/{id}/stream` accepts live audio chunks (PCM 16-bit, 16kHz mono). Server buffers into segments (default 10 seconds), writes chunks to GCS, publishes each for transcription. Sends back JSON frames with interim transcript results. On close, finalizes meeting and triggers full processing.

**Audio playback:** `GET /api/meetings/{id}/audio` returns a signed GCS URL (1-hour expiry).

### CAP-2: Transcription with Pluggable Backends

Adapter-based transcription with three backends:

**Deepgram (default):** Uses `@deepgram/sdk` Nova-2 model. Diarization, smart formatting, punctuation, utterance detection. Supports streaming via WebSocket API. ~$0.0043/minute.

**Self-hosted Whisper:** Calls a configurable HTTP endpoint (`WHISPER_ENDPOINT` env var). Sends audio, receives JSON transcript with timestamps. Diarization via separate `DIARIZATION_ENDPOINT` (pyannote). Batch only, no streaming.

**Google Speech-to-Text:** Uses `@google-cloud/speech` v2 Chirp model. Built-in diarization. Streaming via gRPC.

Backend selected per-user via preferences, overridable per-request with `?backend=deepgram|whisper|google-stt`.

Transcripts stored as segments in Firestore: speaker label, text, start/end time (seconds), confidence score, channel (system_audio/microphone/user_input).

### CAP-3: AI Note Generation

Merge a meeting's transcript + user-typed notes + template into structured meeting notes via Claude API.

**Flow:**
1. Load transcript segments ordered by time
2. Load user-typed notes (flagged segments)
3. Load selected template
4. Build prompt: transcript as `[MM:SS] Speaker: text`, user notes as `USER NOTE [MM:SS]: text`, template sections as output instructions
5. Call Claude API (Sonnet for speed, Opus available for complex meetings)
6. Parse response into sections matching template headings
7. Extract action items from output, save separately
8. Auto-tag meeting based on content
9. Generate embeddings for each section (for semantic search)
10. Save notes with version number

**Regeneration:** `POST /api/meetings/{id}/notes/generate` with optional `templateId` regenerates notes with a different template. Preserves previous versions. Warns if user has manually edited current notes.

User model budget per note generation: Sonnet default, configurable.

### CAP-4: Meeting Templates

Built-in system templates (read-only):

1. **General** -- Summary, Key Discussion Points, Decisions, Action Items, Follow-ups
2. **1:1** -- Summary, Updates Since Last, Discussion Points, Action Items, Feedback/Concerns
3. **Sales Call** -- Summary, Prospect Needs, Budget/Timeline, Objections, Competitive Mentions, Next Steps, BANT Qualification
4. **Standup** -- Per-Person Updates (Yesterday/Today/Blockers), Team Action Items
5. **Retrospective** -- What Went Well, What Didn't, Action Items for Improvement
6. **Interview** -- Candidate Summary, Technical Assessment, Culture Fit, Concerns, Hiring Recommendation
7. **Board/Executive** -- Executive Summary, Key Metrics, Strategic Decisions, Risks, Action Items

Each template has sections: `{ heading, prompt }` where `prompt` instructs Claude what to extract for that section.

Custom templates: users can create, edit, and delete their own. System templates are seeded on first run.

**Endpoints:**
- `GET /api/templates` -- list all (system + custom)
- `GET /api/templates/{id}` -- detail
- `POST /api/templates` -- create custom
- `PUT /api/templates/{id}` -- update custom (403 on system)
- `DELETE /api/templates/{id}` -- delete custom

### CAP-5: Meeting CRUD and Library

**Endpoints:**
- `POST /api/meetings` -- create meeting (manual or from calendar event)
- `GET /api/meetings` -- list with pagination, filtering (date, attendee, tag, starred), sorting
- `GET /api/meetings/{id}` -- detail with latest notes summary
- `PUT /api/meetings/{id}` -- update title, tags, attendees, star/unstar
- `DELETE /api/meetings/{id}` -- delete meeting + all data + audio from GCS
- `GET /api/meetings/{id}/transcript` -- full transcript (all segments ordered)
- `GET /api/meetings/{id}/speakers` -- speaker list with resolved names
- `PUT /api/meetings/{id}/speakers/{speakerId}` -- rename/resolve a speaker
- `GET /api/meetings/{id}/notes` -- list all note versions
- `GET /api/meetings/{id}/notes/latest` -- latest notes
- `GET /api/meetings/{id}/notes/{version}` -- specific version
- `PUT /api/meetings/{id}/notes/{version}` -- edit notes (sets isEdited flag)

Meeting statuses: `recording | processing | ready | failed`

### CAP-6: User Notes Ingestion

During a meeting, the desktop client sends the user's typed notes to the API.

- `POST /api/meetings/{id}/user-notes` -- body `{ text, timestamp? }`. Stores as a transcript segment with `isUserNote: true`. Timestamp is seconds from meeting start (defaults to current time minus startedAt).
- `GET /api/meetings/{id}/user-notes` -- retrieve all user notes for a meeting

These notes become "anchors" during note generation -- they tell Claude what the user found important.

### CAP-7: Search

**Full-text:** `GET /api/search?q=...&type=meetings|notes|actions|all` with filters: dateFrom, dateTo, attendee, tag, status, isStarred. Cursor-based pagination. Searches across meeting titles, transcript text, note content, action item titles.

**Semantic:** `GET /api/search/semantic?q=...` generates embedding for query, performs vector similarity search across stored meeting embeddings. Returns meetings ranked by cosine similarity with snippet highlighting. Same filters as full-text.

Embeddings generated after note generation: meeting notes and transcript split into ~500-token chunks, embedded via Vertex AI (`text-embedding-004`) or configurable local endpoint (`EMBEDDING_ENDPOINT`).

### CAP-8: Cross-Meeting AI Q&A

`POST /api/ai/ask` with body `{ question, filters?: { dateRange?, attendees?, tags?, meetingIds? } }`

RAG pipeline:
1. Embed the question
2. Retrieve top-20 relevant chunks from meeting embeddings
3. Apply filters
4. Build Claude prompt with retrieved context (annotated with meeting title, date, speaker)
5. Generate answer with citations (references to specific meetings + timestamps)

**Meeting prep:** `POST /api/ai/meeting-prep` with body `{ calendarEventId }` or `{ attendees }`. Finds all past meetings with overlapping attendees. Generates prep brief: previous topics, open action items, relationship context, suggested talking points.

Rate limit AI endpoints: 10 requests/min (expensive operations).

### CAP-9: Action Item Tracking

Extracted automatically during note generation. Also supports manual creation.

- `GET /api/actions` -- all user's action items (filterable by status, assignee, meeting, due date)
- `GET /api/actions/summary` -- dashboard: total open, overdue, due this week, recently completed, grouped by assignee
- `GET /api/meetings/{id}/actions` -- actions for specific meeting
- `POST /api/actions` -- create manual action item
- `PUT /api/actions/{id}` -- update status, assignee, due date, title
- `DELETE /api/actions/{id}` -- delete

Action item fields: title, assignee (name/email), dueDate, status (open/in_progress/completed/cancelled), source (ai_extracted/manual), linked transcript segment.

### CAP-10: Google Calendar Integration

- `POST /api/calendar/connect` -- initiate OAuth2 flow
- `GET /api/calendar/callback` -- OAuth callback
- `GET /api/calendar/events?dateFrom=...&dateTo=...` -- list events
- `POST /api/calendar/sync` -- incremental sync via sync tokens
- `DELETE /api/calendar/disconnect` -- revoke access

Auto-meeting creation: periodic sync (every 5 minutes via internal cron) detects upcoming/started events, creates meeting records pre-populated with title, attendees, description from calendar.

Attendee resolution: match calendar attendee emails against known users for speaker identification.

### CAP-11: Shareable Meeting Notes

- `POST /api/meetings/{id}/share` -- create share link. Body: `{ access, allowedEmails?, includeTranscript, includeAudio, expiresAt? }`. Access modes: public (no auth), authenticated (any valid JWT), specific_emails (JWT + email check).
- `GET /api/share/{shareId}` -- view shared notes (public endpoint for public shares). Returns title, date, attendee names (no emails), notes, optionally transcript/audio. Increments view count. 404 if expired.
- `GET /api/meetings/{id}/shares` -- list shares for a meeting
- `DELETE /api/share/{shareId}` -- revoke share

### CAP-12: User Profile and Preferences

- `GET /api/me` -- current user profile + preferences
- `PUT /api/me` -- update preferences
- `DELETE /api/me` -- delete account + all data (GDPR)

Preferences: defaultTemplateId, transcriptionBackend, autoTranscribe (boolean), timezone, language (ISO 639-1).

### CAP-13: Health

- `GET /health` -- no auth. Returns `{ status: "ok", version }`.
- `GET /health/ready` -- readiness probe. Checks Firestore and GCS connectivity.

---

## 6) Required Secrets

- `ANTHROPIC_API_KEY` -- Claude API for note generation and Q&A
- `DEEPGRAM_API_KEY` -- Deepgram transcription (if using Deepgram backend)
- `FIREBASE_SERVICE_ACCOUNT` -- Firebase Auth + Firestore
- `GCS_BUCKET` -- Cloud Storage bucket name
- `GOOGLE_CLOUD_PROJECT` -- GCP project ID

Optional:
- `WHISPER_ENDPOINT` -- self-hosted Whisper URL
- `DIARIZATION_ENDPOINT` -- self-hosted pyannote URL
- `EMBEDDING_ENDPOINT` -- self-hosted embedding endpoint

---

## 7) Security Principles

- Firebase Auth JWT required on all `/api/*` routes
- Internal routes (`/internal/*`) authenticated via Pub/Sub OIDC tokens
- Share routes: access depends on share settings (public/authenticated/specific_emails)
- All Firestore queries scoped to userId -- users can only access their own data
- Audio files stored under `audio/{userId}/` with signed URLs for access
- Rate limiting: 100 req/min on API routes, 10 req/min on AI routes
- Input validation via Zod on all request bodies and query params
- No PII in logs (transcript content, user notes, attendee emails never logged)
- Secrets never in agent prompts
- Constant-time token comparison

---

## 8) IAM Requirements

**Operator:**
- roles/run.admin
- roles/cloudbuild.builds.editor
- roles/secretmanager.admin
- roles/pubsub.admin

**Runtime Service Account:**
- roles/secretmanager.secretAccessor
- roles/logging.logWriter
- roles/datastore.user (Firestore)
- roles/storage.objectAdmin (GCS)
- roles/aiplatform.user (Vertex AI embeddings)

---

## 9) Verification (Smoke Tests)

Deployment is SUCCESS only if:

- `GET /health` returns 200 with `{ status: "ok" }`
- `GET /health/ready` returns 200
- `POST /api/meetings` creates a meeting (201)
- `GET /api/meetings` returns the meeting in the list
- `POST /api/meetings/{id}/audio` accepts upload (202)
- `POST /api/meetings/{id}/user-notes` stores note segment
- `GET /api/meetings/{id}/transcript` returns segments
- `POST /api/meetings/{id}/notes/generate` generates notes
- `GET /api/meetings/{id}/notes/latest` returns notes with sections
- `GET /api/search?q=test` returns results
- `POST /api/ai/ask` returns answer with citations
- `GET /api/actions` returns action items
- `POST /api/meetings/{id}/share` creates link
- `GET /api/share/{shareId}` returns notes without auth (public share)
- `GET /api/templates` returns built-in templates
- `GET /api/meetings` returns 401 without valid JWT

---

## 10) Observability

Structured JSON logs:

- Meeting lifecycle (created, recording, processing, ready, failed)
- Audio processing (received, adapter called, segments written, duration)
- AI operations (Claude calls with model, tokens, latency, cost)
- Search queries (type, query length, result count, latency)
- WebSocket connections (opened, bytes received, closed)
- Calendar sync (events synced, meetings created)
- Auth (verification success/failure, no PII)
- Share access (shareId, access type, view count)
- Error breakdown by route, service, adapter

All logs include requestId and userId.

---

## 11) Performance Constraints

- Meeting creation: < 100ms
- Audio upload (100MB): < 30s + 202 accepted
- Transcription (1hr meeting): < 5 min (Deepgram), < 15 min (Whisper)
- Note generation: < 30s
- Full-text search: < 500ms
- Semantic search: < 2s
- Cross-meeting Q&A: < 10s
- API CRUD operations: < 300ms

---

## 12) Failure Handling

- Transcription failure: retry 3x with backoff, then mark meeting failed with error
- Claude API failure: retry 2x, then return partial results (transcript without notes), queue retry
- GCS failure: retry 3x, then 503
- Firestore unavailable: retry 3x, then 503
- WebSocket disconnect: chunks already in GCS preserved, client reconnects
- Embedding failure: non-blocking, notes still available, semantic search degraded
- Calendar token expired: auto-refresh, if fails disconnect and notify user
- Invalid audio format: 400 with supported formats
- Oversized audio: 413 with max size

---

## 13) Async Processing Pipeline

Pub/Sub topic: `audio-processing`

Push subscriber at `/internal/process-audio`:
1. Download audio from GCS
2. Call transcription adapter
3. Write transcript segments to Firestore (batch writes)
4. Calculate speaker statistics (talk time per speaker)
5. If autoTranscribe enabled: trigger note generation
6. Update meeting status

Retry: 3 attempts with exponential backoff. Dead-letter topic after exhaustion.

---

## 14) Future Enhancements (v2+)

- Desktop app (Tauri) with system audio capture
- Multi-tenant SaaS mode
- Slack/Teams integration for posting summaries
- CRM sync (HubSpot, Salesforce)
- Meeting analytics (talk time ratios, sentiment trends)
- Custom AI prompts per meeting ("extract all feature requests")
- Offline mode with local Whisper + Ollama
- Team workspaces with shared meeting libraries
- Meeting clips (shareable transcript excerpts with audio)
- Voice profile training for better speaker identification

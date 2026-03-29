# Threat Model — PRD -- Muesli: Open-Source Meeting Intelligence API v1

## Attack Surface

- **REST API endpoints (/api/*)**: All CRUD operations, search, AI endpoints. Protected by Firebase Auth JWT. Exposed to any client with a valid JWT.

- **WebSocket endpoint (WS /api/meetings/:id/stream)**: Live audio streaming. Long-lived connection. Auth on upgrade only. Accepts raw PCM binary data. Buffer overflow and resource exhaustion risks.

- **Public share endpoint (GET /api/share/:shareId)**: No authentication for public shares. shareId acts as a bearer token. Exposed to the internet. Enumeration and brute-force risks.

- **Internal endpoints (/internal/*)**: Pub/Sub push and Cloud Scheduler triggers. OIDC token authentication. Should not be reachable by external clients if Cloud Run ingress is configured correctly, but currently appears accessible.

- **Health endpoints (/health, /health/ready)**: No authentication. Exposes service status, version, and dependency health. Could reveal infrastructure details.

- **Google Calendar OAuth2 callback (GET /api/calendar/callback)**: OAuth2 redirect endpoint. Receives authorization code. CSRF risk if state parameter is not validated. Open redirect risk if redirect URI is not strictly validated.

- **Audio files in GCS**: Accessed via signed URLs with 1-hour expiry. URLs are bearer tokens. If leaked, grants temporary access to audio content.

- **Claude API prompts**: Transcript content and user notes are sent to Anthropic's API. Data leaves the self-hosted boundary. Prompt injection via transcript content or user notes.

- **Transcription service endpoints**: Audio sent to Deepgram (cloud), self-hosted Whisper, or Google STT. For Deepgram, audio leaves the self-hosted boundary.

- **Firestore database**: All application data including transcripts, notes, tokens, embeddings. Access controlled by IAM. No application-level encryption beyond Firestore default encryption at rest.


## Identified Threats

| Threat | Category | Likelihood | Impact | Mitigation |
|--------|----------|------------|--------|------------|
| Insecure Direct Object Reference (IDOR) on meeting resources | access | high | high | Every Firestore query MUST include userId filter derived from the verified JWT (not from request parameters). Never trust meetingId alone for authorization. Verify meeting ownership before any operation. Unit test that queries always include userId scope.
 |
| Share link brute-force / enumeration | access | medium | high | Use cryptographically random shareId (e.g., crypto.randomUUID() or nanoid with sufficient entropy, minimum 128 bits). Rate limit GET /api/share/:shareId. Return identical 404 for expired, revoked, and non-existent shares (no information leakage). Consider adding a short HMAC signature to shareIds.
 |
| Prompt injection via transcript or user notes | injection | medium | medium | Transcript content and user notes are included in Claude prompts. A meeting participant could speak or type content designed to manipulate the AI output. Sanitize or clearly delimit user-provided content in prompts. Use structured prompts with clear boundaries. Validate AI output structure matches expected template sections. Never execute commands or code from AI output.
 |
| WebSocket resource exhaustion | misconfig | medium | high | Implement per-user concurrent WebSocket connection limits. Set maximum connection duration (e.g., 4 hours for long meetings). Implement backpressure on incoming audio chunks. Set maximum buffer size per connection. Validate PCM audio format (sample rate, bit depth, channels). Rate limit chunk ingestion per connection.
 |
| Audio file size abuse (500MB limit) | misconfig | medium | medium | Enforce 500MB limit at the Fastify multipart parser level (not just validation). Use streaming upload to GCS to avoid holding entire file in memory. Validate Content-Length header before accepting upload. Reject audio with incorrect MIME types early.
 |
| Calendar OAuth2 CSRF and token theft | csrf | medium | high | Generate and validate a cryptographic state parameter in the OAuth2 flow. Bind state to the user's session/JWT. Validate redirect_uri strictly matches the configured callback URL. Store refresh tokens encrypted in Firestore (not just Firestore's default at-rest encryption — use application-level encryption with a key from Secret Manager). Implement token scope minimization (request only calendar.readonly and calendar.events.readonly).
 |
| JWT replay / stolen token abuse | auth | medium | high | Firebase JWT has 1-hour expiry. Consider using verifyIdToken with checkRevoked=true for sensitive operations (note generation, account deletion, calendar connect) at the cost of an additional network call. The PRD mentions constant-time token comparison but JWT verification is signature-based, not comparison-based. Ensure HTTPS-only for all endpoints.
 |
| Sensitive data exposure in API responses | exposure | medium | medium | Share endpoint must strip attendee emails (return names only). Error responses must not include stack traces or internal details in production. Zod validation errors should be sanitized. Never return raw Firestore document IDs that could reveal data structure. Audit all response schemas.
 |
| PII leakage in logs | exposure | medium | high | PRD requires no PII in logs. Use Pino redaction for request bodies containing transcript content, user notes, attendee emails. Redact Authorization headers. Ensure error serializers don't include request body content. Audit log output in CI.
 |
| Denial of service via AI endpoints | misconfig | high | medium | AI endpoints (Claude API calls) are expensive. Rate limit at 10 req/min per user as specified. Additionally, implement cost tracking per user. Set maximum transcript length for note generation (context window limit). Queue AI operations rather than processing synchronously where possible. Dead-letter failed AI operations to prevent infinite retry loops.
 |
| SSRF via self-hosted Whisper/diarization/embedding endpoints | csrf | medium | high | WHISPER_ENDPOINT, DIARIZATION_ENDPOINT, and EMBEDDING_ENDPOINT are configurable URLs. Validate these at startup (must be HTTPS or whitelisted internal addresses). Do not allow these to be set via API or user input. Validate response schemas from these endpoints. Set request timeouts. Do not follow redirects.
 |
| Privilege escalation via system template mutation | access | low | medium | System templates must be immutable (403 on PUT/DELETE). Verify template ownership in the service layer, not just the route handler. Ensure template isSystem flag cannot be set via user API.
 |
| Account deletion fails to cascade all data | exposure | medium | high | DELETE /api/me must cascade to: all meetings, all audio in GCS, all notes, all actions, all shares, all templates (custom), calendar OAuth tokens, user profile, and embeddings. Implement as a transactional operation or use a saga pattern with compensation. Log each deletion step. Verify in integration tests.
 |
| Pub/Sub message replay / spoofing | auth | low | high | Verify OIDC token on /internal/process-audio and /internal/calendar-sync. Validate the token audience matches the Cloud Run service URL. Validate the token issuer. Process messages idempotently (check meeting status before reprocessing). Use dead-letter topic to prevent infinite retries.
 |
| Signed GCS URL leakage | exposure | medium | medium | 1-hour expiry is appropriate. Do not log signed URLs. Do not include signed URLs in error responses. Consider shorter expiry (15 minutes) if playback UX allows. Signed URLs should only be generated for the meeting owner (verified via userId).
 |
| Cross-meeting data leakage via semantic search | access | medium | high | Semantic search (vector similarity) must be scoped to the authenticated user's embeddings only. Ensure Firestore vector queries include userId filter. The RAG pipeline for cross-meeting Q&A must only retrieve chunks belonging to the requesting user.
 |
| Race condition on meeting status transitions | access | low | medium | Use Firestore transactions for status transitions (recording → processing → ready/failed). Validate current status before transition. Prevent duplicate note generation by checking status before starting.
 |
| Anthropic API key exposure in prompts | exposure | low | high | PRD explicitly states "secrets never in agent prompts." Ensure the Claude adapter does not include API keys, service account credentials, or internal URLs in prompt content. Code review prompt construction carefully.
 |
| Unvalidated transcription backend query parameter | injection | low | medium | The ?backend=deepgram|whisper|google-stt parameter must be validated against an allowlist (Zod enum). Invalid values return 400. This prevents potential injection if backend names were used in dynamic dispatch without validation.
 |
| Missing email verification on specific_emails shares | auth | medium | medium | For specific_emails share access, the JWT email claim must be verified AND email_verified must be true. Without email verification check, a user could create an account with someone else's email and access shares intended for that person.
 |
| Calendar sync creates unauthorized meetings | access | low | low | Calendar sync must only create meetings for users who have connected their calendar. Ensure sync iterates only users with valid calendar tokens. Validate calendar event data before creating meeting records.
 |
| In-memory rate limiter bypass via distributed instances | misconfig | medium | medium | PRD specifies in-memory rate limiting (single-tenant assumption). If Cloud Run scales beyond 1 instance, rate limits are per-instance and can be bypassed. For single-tenant with min-instances=1 and reasonable max-instances, this is acceptable. Document this limitation. Consider Firestore-based counters if multi-instance rate limiting is needed.
 |

## Mitigation Details

### Insecure Direct Object Reference (IDOR) on meeting resources

Every Firestore query MUST include userId filter derived from the verified JWT (not from request parameters). Never trust meetingId alone for authorization. Verify meeting ownership before any operation. Unit test that queries always include userId scope.


### Share link brute-force / enumeration

Use cryptographically random shareId (e.g., crypto.randomUUID() or nanoid with sufficient entropy, minimum 128 bits). Rate limit GET /api/share/:shareId. Return identical 404 for expired, revoked, and non-existent shares (no information leakage). Consider adding a short HMAC signature to shareIds.


### Prompt injection via transcript or user notes

Transcript content and user notes are included in Claude prompts. A meeting participant could speak or type content designed to manipulate the AI output. Sanitize or clearly delimit user-provided content in prompts. Use structured prompts with clear boundaries. Validate AI output structure matches expected template sections. Never execute commands or code from AI output.


### WebSocket resource exhaustion

Implement per-user concurrent WebSocket connection limits. Set maximum connection duration (e.g., 4 hours for long meetings). Implement backpressure on incoming audio chunks. Set maximum buffer size per connection. Validate PCM audio format (sample rate, bit depth, channels). Rate limit chunk ingestion per connection.


### Audio file size abuse (500MB limit)

Enforce 500MB limit at the Fastify multipart parser level (not just validation). Use streaming upload to GCS to avoid holding entire file in memory. Validate Content-Length header before accepting upload. Reject audio with incorrect MIME types early.


### Calendar OAuth2 CSRF and token theft

Generate and validate a cryptographic state parameter in the OAuth2 flow. Bind state to the user's session/JWT. Validate redirect_uri strictly matches the configured callback URL. Store refresh tokens encrypted in Firestore (not just Firestore's default at-rest encryption — use application-level encryption with a key from Secret Manager). Implement token scope minimization (request only calendar.readonly and calendar.events.readonly).


### JWT replay / stolen token abuse

Firebase JWT has 1-hour expiry. Consider using verifyIdToken with checkRevoked=true for sensitive operations (note generation, account deletion, calendar connect) at the cost of an additional network call. The PRD mentions constant-time token comparison but JWT verification is signature-based, not comparison-based. Ensure HTTPS-only for all endpoints.


### Sensitive data exposure in API responses

Share endpoint must strip attendee emails (return names only). Error responses must not include stack traces or internal details in production. Zod validation errors should be sanitized. Never return raw Firestore document IDs that could reveal data structure. Audit all response schemas.


### PII leakage in logs

PRD requires no PII in logs. Use Pino redaction for request bodies containing transcript content, user notes, attendee emails. Redact Authorization headers. Ensure error serializers don't include request body content. Audit log output in CI.


### Denial of service via AI endpoints

AI endpoints (Claude API calls) are expensive. Rate limit at 10 req/min per user as specified. Additionally, implement cost tracking per user. Set maximum transcript length for note generation (context window limit). Queue AI operations rather than processing synchronously where possible. Dead-letter failed AI operations to prevent infinite retry loops.


### SSRF via self-hosted Whisper/diarization/embedding endpoints

WHISPER_ENDPOINT, DIARIZATION_ENDPOINT, and EMBEDDING_ENDPOINT are configurable URLs. Validate these at startup (must be HTTPS or whitelisted internal addresses). Do not allow these to be set via API or user input. Validate response schemas from these endpoints. Set request timeouts. Do not follow redirects.


### Privilege escalation via system template mutation

System templates must be immutable (403 on PUT/DELETE). Verify template ownership in the service layer, not just the route handler. Ensure template isSystem flag cannot be set via user API.


### Account deletion fails to cascade all data

DELETE /api/me must cascade to: all meetings, all audio in GCS, all notes, all actions, all shares, all templates (custom), calendar OAuth tokens, user profile, and embeddings. Implement as a transactional operation or use a saga pattern with compensation. Log each deletion step. Verify in integration tests.


### Pub/Sub message replay / spoofing

Verify OIDC token on /internal/process-audio and /internal/calendar-sync. Validate the token audience matches the Cloud Run service URL. Validate the token issuer. Process messages idempotently (check meeting status before reprocessing). Use dead-letter topic to prevent infinite retries.


### Signed GCS URL leakage

1-hour expiry is appropriate. Do not log signed URLs. Do not include signed URLs in error responses. Consider shorter expiry (15 minutes) if playback UX allows. Signed URLs should only be generated for the meeting owner (verified via userId).


### Cross-meeting data leakage via semantic search

Semantic search (vector similarity) must be scoped to the authenticated user's embeddings only. Ensure Firestore vector queries include userId filter. The RAG pipeline for cross-meeting Q&A must only retrieve chunks belonging to the requesting user.


### Race condition on meeting status transitions

Use Firestore transactions for status transitions (recording → processing → ready/failed). Validate current status before transition. Prevent duplicate note generation by checking status before starting.


### Anthropic API key exposure in prompts

PRD explicitly states "secrets never in agent prompts." Ensure the Claude adapter does not include API keys, service account credentials, or internal URLs in prompt content. Code review prompt construction carefully.


### Unvalidated transcription backend query parameter

The ?backend=deepgram|whisper|google-stt parameter must be validated against an allowlist (Zod enum). Invalid values return 400. This prevents potential injection if backend names were used in dynamic dispatch without validation.


### Missing email verification on specific_emails shares

For specific_emails share access, the JWT email claim must be verified AND email_verified must be true. Without email verification check, a user could create an account with someone else's email and access shares intended for that person.


### Calendar sync creates unauthorized meetings

Calendar sync must only create meetings for users who have connected their calendar. Ensure sync iterates only users with valid calendar tokens. Validate calendar event data before creating meeting records.


### In-memory rate limiter bypass via distributed instances

PRD specifies in-memory rate limiting (single-tenant assumption). If Cloud Run scales beyond 1 instance, rate limits are per-instance and can be bypassed. For single-tenant with min-instances=1 and reasonable max-instances, this is acceptable. Document this limitation. Consider Firestore-based counters if multi-instance rate limiting is needed.


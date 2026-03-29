# RBAC Matrix — PRD -- Muesli: Open-Source Meeting Intelligence API v1

| Role | Permissions | Access Rules |
|------|------------|--------------|
| authenticated_user | meetings.create, meetings.read_own, meetings.update_own, meetings.delete_own, meetings.upload_audio, meetings.stream_audio, meetings.playback_audio, transcript.read_own, speakers.read_own, speakers.update_own, notes.read_own, notes.edit_own, notes.generate, user_notes.create, user_notes.read_own, templates.read_all, templates.create_custom, templates.update_own_custom, templates.delete_own_custom, actions.read_own, actions.create, actions.update_own, actions.delete_own, search.fulltext, search.semantic, ai.ask, ai.meeting_prep, calendar.connect, calendar.disconnect, calendar.sync, calendar.read_events, share.create, share.list_own, share.revoke_own, profile.read, profile.update, profile.delete | All Firestore queries MUST include userId scope. Users can only access their own meetings, notes, actions, templates (custom), and calendar data. Audio files restricted to audio/{userId}/ GCS prefix.
 |
| share_viewer_public | share.view_public | No authentication required. Can only view meeting notes via GET /api/share/{shareId} where share access mode is 'public'. Returns title, date, attendee names (no emails), notes, and optionally transcript/audio. Cannot enumerate shares. 404 if expired.
 |
| share_viewer_authenticated | share.view_authenticated | Requires valid Firebase Auth JWT. Any authenticated user can view the shared content. Same data restrictions as public shares (no attendee emails).
 |
| share_viewer_specific | share.view_specific | Requires valid Firebase Auth JWT AND email claim in JWT must match one of the allowedEmails in the share record. Email verification status must be checked.
 |
| pubsub_worker | internal.process_audio | Authenticated via Pub/Sub OIDC token. Only accepts requests at /internal/process-audio. Verified via Google-signed OIDC JWT with the push invoker service account identity.
 |
| calendar_sync_worker | internal.calendar_sync | Authenticated via Cloud Scheduler OIDC token. Only accepts requests at /internal/calendar-sync. Triggered every 5 minutes.
 |
| operator | deploy.cloud_run, manage.secrets, manage.pubsub, manage.cloud_build | GCP IAM roles for infrastructure management. Not an application-level role.
 |
| runtime_service_account | secrets.read, firestore.readwrite, gcs.readwrite, vertex_ai.predict, logging.write | Used by the application at runtime. Least-privilege scoped to specific resources needed by the API.
 |

## Required External Permissions

### Firebase Auth

- **firebaseauth.users.get (via verifyIdToken)**: Verify JWT tokens on all /api/* routes and extract userId
  - _Risk: If Firebase Auth is compromised or misconfigured, all API authorization is bypassed. Key caching (6hr) means revoked keys may remain valid briefly.
_

### Google Cloud Firestore

- **datastore.entities.create**: Create meetings, notes, actions, templates, user profiles, shares
  - _Risk: Write access to all application data. Misconfigured queries without userId scope leak data._
- **datastore.entities.get**: Read all application data scoped to userId
  - _Risk: Read access to confidential meeting content, transcripts, and notes._
- **datastore.entities.update**: Update meeting status, notes, action items, user preferences
  - _Risk: Could corrupt application state if misused._
- **datastore.entities.delete**: Delete meetings, cascade deletions, account deletion
  - _Risk: Data loss. Must ensure cascade is complete._
- **datastore.indexes.list**: Query using composite indexes for search and filtering
  - _Risk: Low — read-only metadata operation._

### Google Cloud Storage

- **storage.objects.create**: Upload audio files to audio/{userId}/{meetingId}/ prefix
  - _Risk: Storage cost abuse if upload size limits are bypassed._
- **storage.objects.get**: Download audio for transcription processing and generate signed URLs
  - _Risk: Access to confidential audio recordings._
- **storage.objects.delete**: Delete audio on meeting deletion and account deletion
  - _Risk: Irreversible data loss. Must verify ownership before deletion._
- **iam.serviceAccounts.signBlob**: Generate V4 signed URLs for audio playback (signBlob on Cloud Run)
  - _Risk: Allows creating signed URLs for any object in the bucket. Must be scoped to the runtime service account only. signBlob quota is 60,000/min per project.
_

### Google Cloud Pub/Sub

- **pubsub.topics.publish**: Publish audio processing messages to audio-processing topic
  - _Risk: If publishing is compromised, could trigger unauthorized transcription of arbitrary audio or exhaust transcription API quotas.
_
- **pubsub.subscriptions.consume**: Receive push messages at /internal/process-audio
  - _Risk: Message replay could trigger duplicate processing. Idempotency required._

### Anthropic Claude API

- **ANTHROPIC_API_KEY (API key auth)**: Note generation (Sonnet/Opus), cross-meeting Q&A (RAG), meeting prep, action item extraction, auto-tagging

  - _Risk: Cost exposure — each call consumes tokens. A compromised key allows unlimited API usage. Transcript content is sent to Anthropic's servers (leaves self-hosted boundary). Rate limit AI endpoints to 10 req/min.
_

### Deepgram API

- **DEEPGRAM_API_KEY (API key auth)**: Audio transcription with Nova-2 model, streaming and batch
  - _Risk: Audio content is sent to Deepgram's cloud (leaves self-hosted boundary). Cost at ~$0.0043/minute. Key compromise enables unauthorized transcription.
_

### Google Cloud Speech-to-Text

- **speech.recognize (via roles/speech.client or roles/aiplatform.user)**: Transcription via Chirp model with built-in diarization
  - _Risk: Audio sent to Google STT API. Costs per minute of audio._

### Vertex AI

- **aiplatform.endpoints.predict**: Generate text embeddings (text-embedding-004) for semantic search
  - _Risk: Meeting content chunks sent to Vertex AI for embedding. Non-blocking — failure degrades search, not core functionality. Cost per million tokens.
_

### Google Calendar API

- **calendar.readonly (OAuth2 scope)**: Read calendar events for meeting context and auto-creation
  - _Risk: Access to user's full calendar. Refresh tokens grant persistent access. Must be encrypted in storage. Auto-revoke on disconnect or refresh failure.
_
- **calendar.events.readonly (OAuth2 scope)**: Read event details including attendees and descriptions
  - _Risk: Attendee emails are PII. Event descriptions may contain confidential information (meeting agendas, links, passwords).
_

### Google Cloud Secret Manager

- **secretmanager.versions.access**: Read API keys and credentials at runtime
  - _Risk: Access to all application secrets. If the runtime service account is compromised, all secrets are exposed. Scope to specific secrets using secret-level IAM bindings rather than project-level.
_

### Google Cloud Logging

- **logging.logEntries.create**: Write structured JSON logs for all operations
  - _Risk: Low — write-only. Ensure PII redaction is enforced before logging._

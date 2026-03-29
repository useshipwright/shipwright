# Event Taxonomy — PRD -- Muesli: Open-Source Meeting Intelligence API v1

| Event | Source | Payload | Consumers | Ordering |
|-------|--------|---------|-----------|----------|
| audio-processing | API server (published on audio upload or WebSocket stream close) | meetingId, userId, audioPath (GCS URI), backend (deepgram|wh... | /internal/process-audio push subscriber | at-least-once delivery via Pub/Sub, no strict ordering |
| transcription-complete | Internal process-audio handler (after transcript segments written) | meetingId, userId, segmentCount, speakerCount, durationSecon... | Note generation trigger (if autoTranscribe enabled) | at-least-once |
| note-generation-complete | AI note generation pipeline | meetingId, userId, noteVersion, templateId, model, tokenCoun... | Embedding generation, action item extraction | at-least-once |
| calendar-sync-tick | Internal cron (every 5 minutes) | userId, syncToken, eventsFound, meetingsCreated | Meeting auto-creation from calendar events | sequential per user (cron-driven) |
| websocket-audio-stream | Client WebSocket connection at /api/meetings/{id}/stream | PCM 16-bit 16kHz mono audio chunks, buffered into 10-second ... | GCS storage writer, real-time transcription adapter | ordered within single WebSocket connection |
| share-access | Public/authenticated share endpoint GET /api/share/{shareId} | shareId, accessType (public|authenticated|specific_emails), ... | View count incrementer, audit logger | none required |
| meeting-lifecycle | Various API endpoints and internal processors | meetingId, userId, status (recording|processing|ready|failed... | Audit logger, client notification (via polling or future WebSocket) | status transitions are sequential per meeting |

## audio-processing — Idempotency

Use meetingId + segmentIndex as idempotency key; check if transcript segments already exist before writing

## transcription-complete — Idempotency

Check meeting status — skip if already in ready state or notes already generated for this version

## note-generation-complete — Idempotency

Version number on notes — skip if version already exists

## calendar-sync-tick — Idempotency

Match on calendarEventId — skip if meeting already exists for that event

## websocket-audio-stream — Idempotency

Chunk sequence numbers; GCS writes are append-only per segment index

## share-access — Idempotency

View count is increment-only, no dedup needed

## meeting-lifecycle — Idempotency

Compare previousStatus — skip if transition already applied

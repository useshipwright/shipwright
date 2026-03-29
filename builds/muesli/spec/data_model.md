# Data Model — PRD -- Muesli: Open-Source Meeting Intelligence API v1

## Entities

### User

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, matches Firebase Auth UID |
| email | string | indexed |
| displayName | string | nullable |
| defaultTemplateId | string | nullable, references Template.id |
| transcriptionBackend | string | enum: deepgram|whisper|google-stt, default: deepgram |
| autoTranscribe | boolean | default: true |
| timezone | string | default: UTC |
| language | string | ISO 639-1, default: en |
| calendarConnected | boolean | default: false |
| calendarTokens | object | nullable, contains accessToken, refreshToken, expiry. Encrypted at rest via Firestore. |
| calendarSyncToken | string | nullable, Google Calendar incremental sync token |
| createdAt | datetime | not null |
| updatedAt | datetime | not null |

**Relationships:**
- has_many Meeting
- has_many Template (custom only)
- has_many ActionItem

### Meeting

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, auto-generated |
| userId | string | not null, indexed, references User.id |
| title | string | not null |
| status | string | enum: recording|processing|ready|failed, indexed |
| error | string | nullable, populated when status=failed |
| startedAt | datetime | nullable |
| endedAt | datetime | nullable |
| durationSeconds | number | nullable |
| attendees | array of objects | each: { name, email? } |
| tags | array of strings | indexed (array-contains) |
| isStarred | boolean | default: false, indexed |
| calendarEventId | string | nullable, indexed |
| audioPath | string | nullable, GCS object path |
| latestNoteVersion | number | default: 0 |
| speakerStats | object | nullable, { speakerId: { talkTimeSeconds, segmentCount } } |
| searchTokens | array of strings | indexed (array-contains), lowercase tokenized title + attendee names |
| createdAt | datetime | not null, indexed |
| updatedAt | datetime | not null |

**Relationships:**
- has_many TranscriptSegment (subcollection)
- has_many MeetingNote (subcollection)
- has_many ActionItem
- has_many Share
- has_many Speaker (subcollection)

### TranscriptSegment

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, auto-generated |
| speaker | string | not null, speaker label (e.g., Speaker 1, or resolved name) |
| speakerId | string | not null, stable identifier for speaker within meeting |
| text | string | not null |
| startTime | number | not null, seconds from meeting start |
| endTime | number | not null, seconds from meeting start |
| confidence | number | 0-1, nullable for user notes |
| channel | string | enum: system_audio|microphone|user_input |
| isUserNote | boolean | default: false |
| searchTokens | array of strings | indexed (array-contains), lowercase tokenized text |

**Relationships:**
- belongs_to Meeting (parent document)

### Speaker

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, matches speakerId in segments |
| label | string | not null, original diarization label |
| resolvedName | string | nullable |
| resolvedEmail | string | nullable |

**Relationships:**
- belongs_to Meeting (parent document)

### MeetingNote

| Field | Type | Constraints |
|-------|------|------------|
| version | number | primary key (document ID), incrementing |
| templateId | string | not null, references Template.id |
| sections | array of objects | each: { heading: string, content: string } |
| isEdited | boolean | default: false |
| model | string | not null, e.g., claude-sonnet-4-6 |
| inputTokens | number | not null |
| outputTokens | number | not null |
| generationLatencyMs | number | not null |
| createdAt | datetime | not null |

**Relationships:**
- belongs_to Meeting (parent document)

### Template

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, auto-generated |
| name | string | not null |
| isSystem | boolean | not null, system templates are read-only |
| userId | string | nullable (null for system templates), indexed |
| sections | array of objects | each: { heading: string, prompt: string } |
| createdAt | datetime | not null |
| updatedAt | datetime | not null |

**Relationships:**
- belongs_to User (for custom templates)

### ActionItem

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, auto-generated |
| userId | string | not null, indexed |
| meetingId | string | nullable, indexed, references Meeting.id |
| title | string | not null |
| assignee | string | nullable, name or email |
| dueDate | datetime | nullable, indexed |
| status | string | enum: open|in_progress|completed|cancelled, indexed, default: open |
| source | string | enum: ai_extracted|manual |
| linkedSegmentId | string | nullable |
| searchTokens | array of strings | indexed (array-contains), lowercase tokenized title |
| createdAt | datetime | not null |
| updatedAt | datetime | not null |

**Relationships:**
- belongs_to Meeting
- belongs_to User

### Share

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, URL-safe random string (nanoid) |
| meetingId | string | not null, indexed, references Meeting.id |
| userId | string | not null, indexed |
| access | string | enum: public|authenticated|specific_emails |
| allowedEmails | array of strings | nullable, only for specific_emails access |
| includeTranscript | boolean | default: false |
| includeAudio | boolean | default: false |
| expiresAt | datetime | nullable |
| viewCount | number | default: 0 |
| createdAt | datetime | not null |

**Relationships:**
- belongs_to Meeting
- belongs_to User

### EmbeddingChunk

| Field | Type | Constraints |
|-------|------|------------|
| id | string | primary key, auto-generated |
| meetingId | string | not null, indexed, references Meeting.id |
| userId | string | not null, indexed |
| source | string | enum: notes|transcript |
| sectionHeading | string | nullable |
| text | string | not null, the ~500-token chunk text |
| embedding | vector | 768 dimensions, Firestore vector field with HNSW index |
| meetingTitle | string | denormalized for RAG context building |
| meetingDate | datetime | denormalized for RAG context building |
| speaker | string | nullable, denormalized for RAG context |
| createdAt | datetime | not null |

**Relationships:**
- belongs_to Meeting

## Storage Strategy

Firebase Firestore as primary database. Chosen because: (1) PRD specifies it, (2) serverless scaling matches Cloud Run, (3) native vector search (added 2024) eliminates need for separate vector DB, (4) subcollections model the meeting→segments/notes hierarchy naturally.
Collection structure: - /users/{userId} — user profile and preferences (including calendar tokens) - /meetings/{meetingId} — meeting documents, userId-indexed for scoping - /meetings/{meetingId}/segments/{segmentId} — transcript segments (subcollection) - /meetings/{meetingId}/notes/{version} — note versions (subcollection) - /meetings/{meetingId}/speakers/{speakerId} — speaker identity (subcollection) - /templates/{templateId} — system + custom templates - /actions/{actionId} — action items, userId-indexed - /shares/{shareId} — share links, meetingId-indexed - /embeddings/{chunkId} — embedding chunks with vector field, userId-indexed
Firestore indexes required: - meetings: composite (userId, createdAt DESC) for listing - meetings: composite (userId, isStarred, createdAt DESC) for starred filter - meetings: composite (userId, status) for status filter - actions: composite (userId, status, dueDate) for dashboard queries - embeddings: vector index (embedding field, HNSW, cosine distance, 768 dims) - All searchTokens fields: single-field array-contains index
Audio files stored in Google Cloud Storage at audio/{userId}/{meetingId}/. Signed URLs for playback (1-hour expiry, via signBlob on Cloud Run).


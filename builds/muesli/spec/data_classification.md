# Data Classification — PRD -- Muesli: Open-Source Meeting Intelligence API v1

| Data Type | Sensitivity | Retention | Consent Required |
|-----------|------------|-----------|-----------------|
| Audio files (meeting recordings) | confidential | Retained until meeting is deleted by user or account deletion (GDPR). Stored in GCS at audio/{userId}/{meetingId}/. No automatic expiration.
 | Yes |
| Transcript segments (speaker-attributed text) | confidential | Retained in Firestore until meeting deletion or account deletion. Contains verbatim speech content which may include PII, financial data, health information, or trade secrets depending on meeting context.
 | Yes |
| User-typed notes | confidential | Stored as transcript segments with isUserNote flag. Same retention as transcripts.
 | No |
| AI-generated meeting notes | confidential | Versioned in Firestore. All versions retained until meeting deletion. May contain summarized PII, decisions, and action items.
 | No |
| Action items (title, assignee name/email, due date) | confidential | Retained until explicitly deleted or cascade-deleted with meeting/account. Contains assignee emails which are PII.
 | No |
| Meeting embeddings (vector representations) | internal | Stored in Firestore vector fields. Regenerated on note regeneration. Deleted with meeting. Embeddings are not human-readable but could theoretically be used for inference attacks on meeting content.
 | No |
| Google Calendar OAuth2 tokens (access + refresh) | restricted | Stored in Firestore under user document. Must be encrypted at rest. Revoked and deleted on calendar disconnect or account deletion. Refresh tokens are long-lived and grant ongoing access to user's calendar.
 | Yes |
| Calendar event data (title, attendees, description) | confidential | Synced from Google Calendar. Stored as meeting metadata. Deleted with meeting. Contains attendee email addresses (PII).
 | Yes |
| Firebase Auth JWT (bearer token) | restricted | Not stored server-side. Verified on each request. 1-hour expiry by default. Never logged.
 | No |
| User profile and preferences | confidential | Retained until account deletion (GDPR DELETE /api/me). Contains userId, email, timezone, language preferences.
 | No |
| Share links and metadata | internal | Retained until revoked or expired. shareId is a bearer token for public shares. View count tracked. Deleted on meeting deletion.
 | No |
| API keys (Anthropic, Deepgram) | restricted | Stored in GCP Secret Manager. Never in code, logs, or prompts. Rotated per organizational policy.
 | No |
| Signed GCS URLs | internal | Generated on demand with 1-hour expiry. Not persisted. Acts as a bearer token for audio access.
 | No |
| AI operation audit logs | internal | Structured JSON logs with model, tokens, latency, cost. Must NOT contain transcript content, user notes, or attendee emails. Retained per GCP Cloud Logging retention policy.
 | No |
| Attendee information (names, emails) | confidential | Stored in meeting records. Emails are PII. Share endpoint must strip emails and return only names. Deleted with meeting.
 | No |

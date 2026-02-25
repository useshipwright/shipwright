# Data Classification — PRD — Firebase Auth Verification Service

| Data Type | Sensitivity | Retention | Consent Required |
|-----------|------------|-----------|-----------------|
| FIREBASE_SERVICE_ACCOUNT_JSON | restricted | Stored in GCP Secret Manager with version pinning. Rotated per organizational policy. Old versions disabled/destroyed after rotation. Never persisted on disk in the container or build artifacts.
 | No |
| Firebase ID Token (JWT) | restricted | Transient — exists only during request processing. Never persisted to disk, database, or logs. First 10 chars logged with [REDACTED] suffix per ADR-007. Tokens expire in 1 hour (Firebase default).
 | No |
| User UID | confidential | Returned in API responses to authorized callers. Partially redacted in logs (first 4 chars + ***). Not persisted beyond request lifecycle.
 | No |
| User Email | confidential | Returned in API responses to authorized callers. Partially redacted in logs (first char + *** + @domain per ADR-007). Not persisted beyond request lifecycle.
 | No |
| Custom Claims | confidential | Returned in verify and user-lookup responses. May contain authorization-sensitive data (roles, permissions). Not persisted. Not individually redacted in logs — the entire token response object should not be logged.
 | No |
| User Profile (UserRecord) | confidential | Returned from user-lookup endpoint. Includes email, displayName, providerData, disabled status, metadata timestamps. passwordHash and passwordSalt may be present if SA has elevated permissions — these MUST be stripped from the response.
 | No |
| Structured Logs | internal | Written to Cloud Logging via stdout. Retained per GCP project log retention policy (default 30 days, configurable). Must contain only redacted PII. Correlation IDs, latency, pass/fail status, batch summaries are acceptable.
 | No |
| Correlation ID | public | Generated per-request (UUID v4) or propagated from X-Request-ID. Returned in response headers. Included in all log entries. No retention concern.
 | No |
| Health Check Response | public | No retention concern. Contains service status and version only. | No |

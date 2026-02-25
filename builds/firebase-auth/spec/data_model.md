# Data Model — PRD — Firebase Auth Verification Service

## Entities

### VerifyRequest

| Field | Type | Constraints |
|-------|------|------------|
| token | string | required, non-empty, valid JWT structure (3 dot-separated base64url segments) |

### VerifyResponse

| Field | Type | Constraints |
|-------|------|------------|
| uid | string | non-empty, ≤128 chars |
| email | string | nullable — absent if user has no email |
| email_verified | boolean | nullable — absent if email is absent |
| name | string | nullable — display name from OIDC provider |
| picture | string | nullable — profile photo URL |
| custom_claims | object (Record<string, unknown>) | nullable — empty object if no custom claims set |
| token_metadata | TokenMetadata | required |

**Relationships:**
- has_one TokenMetadata

### TokenMetadata

| Field | Type | Constraints |
|-------|------|------------|
| iat | integer | required, unix epoch seconds — when token was issued |
| exp | integer | required, unix epoch seconds — when token expires |
| auth_time | integer | required, unix epoch seconds — when user last authenticated |
| iss | string | required, format: https://securetoken.google.com/<project-id> |
| sign_in_provider | string | required, e.g. google.com, password, phone, anonymous |

### BatchVerifyRequest

| Field | Type | Constraints |
|-------|------|------------|
| tokens | string[] | required, min 1, max 25 items, each must be non-empty string |

### BatchVerifyResponse

| Field | Type | Constraints |
|-------|------|------------|
| results | BatchTokenResult[] | same length and order as input tokens array |
| summary | BatchSummary | required |

**Relationships:**
- has_many BatchTokenResult
- has_one BatchSummary

### BatchTokenResult

| Field | Type | Constraints |
|-------|------|------------|
| index | integer | required, 0-based index matching input array position |
| valid | boolean | required |
| uid | string | present only when valid=true |
| email | string | present only when valid=true and user has email |
| email_verified | boolean | present only when valid=true |
| custom_claims | object (Record<string, unknown>) | present only when valid=true |
| token_metadata | TokenMetadata | present only when valid=true |
| error | string | present only when valid=false, enum: expired | invalid | malformed |

### BatchSummary

| Field | Type | Constraints |
|-------|------|------------|
| total | integer | required |
| valid | integer | required |
| invalid | integer | required |

### UserLookupResponse

| Field | Type | Constraints |
|-------|------|------------|
| uid | string | required |
| email | string | nullable |
| email_verified | boolean | required |
| display_name | string | nullable |
| photo_url | string | nullable |
| phone_number | string | nullable, E.164 format |
| disabled | boolean | required |
| custom_claims | object (Record<string, unknown>) | nullable — null if no custom claims |
| provider_data | ProviderInfo[] | required, may be empty array |
| metadata | UserTimestamps | required |

**Relationships:**
- has_many ProviderInfo
- has_one UserTimestamps

### ProviderInfo

| Field | Type | Constraints |
|-------|------|------------|
| provider_id | string | required, e.g. google.com, password, phone |
| uid | string | required, provider-specific user ID |
| email | string | nullable |
| display_name | string | nullable |
| photo_url | string | nullable |

### UserTimestamps

| Field | Type | Constraints |
|-------|------|------------|
| creation_time | string | required, ISO 8601 UTC |
| last_sign_in_time | string | required, ISO 8601 UTC |
| last_refresh_time | string | nullable, ISO 8601 UTC |

### HealthResponse

| Field | Type | Constraints |
|-------|------|------------|
| status | string | required, enum: healthy | degraded |
| firebase_initialized | boolean | required |
| version | string | required, from package.json |
| timestamp | string | required, ISO 8601 UTC |

### ErrorResponse

| Field | Type | Constraints |
|-------|------|------------|
| error | string | required, generic message — e.g. 'Unauthorized', 'Bad Request', 'Not Found' |
| statusCode | integer | required |

## Storage Strategy

No database. This is a stateless verification gateway. Firebase Authentication (Identity Platform) is the identity store, accessed via the Firebase Admin SDK. JWKS public keys are cached in-memory by the SDK (~6 hour TTL from Cache-Control headers). Service state is ephemeral — Cloud Run instances can be created/destroyed freely.


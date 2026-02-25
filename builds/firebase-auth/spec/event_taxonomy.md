# Event Taxonomy — PRD — Firebase Auth Verification Service

| Event | Source | Payload | Consumers | Ordering |
|-------|--------|---------|-----------|----------|
| firebase_sdk_init | Service startup (app bootstrap) | FIREBASE_SERVICE_ACCOUNT_JSON loaded from GCP Secret Manager... | Firebase Admin SDK (internal), Health endpoint (reports init status) | Once at startup, before routes accept traffic |
| token_verification_request | POST /verify — calling microservices | { token: string } — single Firebase ID token (JWT). Validate... | verify route handler → Firebase Admin SDK verifyIdToken(), Structured logger (result, redacted uid, latency) | Synchronous request/response, no ordering between requests |
| batch_verification_request | POST /batch-verify — calling microservices | { tokens: string[] } — array of up to 25 Firebase ID tokens.... | batch-verify route handler → N × Firebase Admin SDK verifyIdToken(), {'Structured logger (batch summary': 'total, valid count, invalid count)'} | Synchronous request/response. Individual token verifications within batch may execute concurrently (Promise.allSettled pattern). No ordering guarantee between tokens within a batch.
 |
| user_lookup_request | GET /user-lookup/:uid — calling microservices | UID path parameter. Firebase Admin SDK getUser(uid) returns ... | user-lookup route handler → Firebase Admin SDK getUser(), Structured logger (redacted UID, result) | Synchronous request/response |
| jwks_cache_refresh | Firebase Admin SDK internal (transparent to application code) | Firebase public keys fetched from Google's JWKS endpoint. Ca... | Firebase Admin SDK (internal — feeds verifyIdToken()), Structured logger (cache refresh events per REQ-012) | SDK manages internally. Key rotation triggers re-fetch when cached key fails verification.
 |
| cloud_run_health_probe | GET /health — Cloud Run liveness/readiness probes + smoke tests | No request body. Returns service health status and Firebase ... | Cloud Run orchestrator (liveness/readiness), Auto-smoke test runner (REQ-020) | Periodic, stateless |

## firebase_sdk_init — Idempotency

Singleton — SDK initialized once per process lifecycle

## token_verification_request — Idempotency

Naturally idempotent — verifying the same token twice yields the same result (until expiry). No state mutation.


## batch_verification_request — Idempotency

Naturally idempotent — same tokens yield same results. No state mutation.


## user_lookup_request — Idempotency

Read-only lookup — naturally idempotent. Returns current state of user record in Firebase Auth.


## jwks_cache_refresh — Idempotency

Cache refresh is idempotent — fetches latest key set regardless.

## cloud_run_health_probe — Idempotency

Stateless read — always idempotent

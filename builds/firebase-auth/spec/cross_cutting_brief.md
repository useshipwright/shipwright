# Coding Standards Brief — Firebase Auth Verification Service

## Auth Pattern

There is no application-level auth middleware. Cloud Run IAM (OIDC service-to-service) rejects unauthenticated callers at the ingress layer before requests reach Fastify. The application trusts that any request it receives is already authenticated.

**Exempt route:** `GET /health` — no auth at any layer (Cloud Run allows unauthenticated for health probes via liveness config, not app code).

Firebase token verification is the *purpose* of the service, not a middleware concern. Routes call `app.firebaseAuth.verifyIdToken()` / `app.firebaseAuth.getUser()` via the Fastify decorator — never import `firebase-admin` directly.

**Import path:** Route handlers access Firebase through `app.firebaseAuth` (decorated by `plugins/firebase.ts`). Only `adapters/firebase-admin.ts` may import `firebase-admin`.

## Shared State

| Singleton | Set by | Access via |
|-----------|--------|------------|
| Firebase Auth instance | `plugins/firebase.ts` | `app.firebaseAuth` decorator |
| Correlation ID | `plugins/correlation-id.ts` | `request.correlationId` |
| Pino logger w/ redaction | `plugins/logging.ts` | `request.log` / `app.log` |

Never instantiate Firebase Admin, create loggers, or generate correlation IDs outside their owning plugin.

## Error Handling

| Scenario | Status | Body |
|----------|--------|------|
| Missing/malformed request body | 400 | Schema validation error (Fastify automatic) |
| Invalid UID format (`user-lookup`) | 400 | Generic message |
| Token fails verification (`/verify`) | 401 | Generic message — no error category (ADR-002) |
| Batch token failure (`/batch-verify`) | 200 | Per-token `valid`/`invalid` with coarse category: `expired`, `invalid`, or `malformed` |
| UID not found (`user-lookup`) | 404 | Generic message |
| Firebase SDK / network error | 500 | Generic message — log details server-side |

**Batch-verify never returns non-200 for verification failures.** Individual token errors are in the response body. Return 400 only for malformed batch requests (>25 tokens, bad schema).

## Security

- **No secrets in code.** `FIREBASE_SERVICE_ACCOUNT_JSON` comes from Secret Manager via Cloud Run `--set-secrets`. Only `adapters/firebase-admin.ts` reads it.
- **Log redaction is mandatory.** All logging goes through Pino serializers (`lib/redact.ts`). Emails → `t***@example.com`, UIDs → `abc1***`, tokens → first 10 chars + `[REDACTED]`, SA JSON → `[REDACTED_CREDENTIAL]`.
- **User-lookup response allowlisting.** Explicitly pick fields from `UserRecord`. Never spread the full object — `passwordHash`/`passwordSalt` must never appear in responses.
- **JWT pre-validation.** `lib/validate-jwt.ts` checks 3-segment base64url structure before calling `verifyIdToken()`. Fail fast on garbage input.
- **Timing normalisation.** `/verify` error responses must include a minimum delay (~50-100ms) so failures don't return faster than successes (ADR-010).
- **No `checkRevoked` in v1.** Documented limitation — tokens are valid for 1 hour even if revoked.

## Build

- **Source:** `service/src/`
- **Tests:** `service/tests/`
- **Package manager:** pnpm
- **ESM only.** `"type": "module"` in package.json. All imports use `.js` extensions. No CJS except `createRequire` in test helpers.
- **Dockerfile:** Three-stage (deps → build → runtime). Runtime uses `node:22-slim`, non-root user, `pnpm deploy --prod` for minimal `node_modules`.
- **Plugin registration name quirk:** `@fastify/sensible` registers as `fastify-sensible`. All `fp()` dependency arrays must use `fastify-sensible`, not `@fastify/sensible`.
- **Test pattern for routes:** Do not use `buildApp()` — it skips route registration when `skipFirebaseInit=true`. Instead, construct Fastify manually with a fake firebase plugin (see ADR-011).

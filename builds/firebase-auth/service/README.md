# Firebase Auth Verification Service

[![CI](https://github.com/CleerConsulting/firebase-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/CleerConsulting/firebase-auth/actions/workflows/ci.yml)

A hardened Firebase Auth token verification microservice built with Fastify and TypeScript. Built and verified by [Shipwright](https://shipwright.build).

## Quick Start

No Firebase credentials needed. The emulator handles everything.

```bash
docker compose up -d --build
bash scripts/smoke-test.sh
```

The smoke test creates a user via the Firebase Auth Emulator, then verifies all endpoints with real tokens.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with Firebase init status |
| `POST` | `/verify` | Verify a single Firebase ID token |
| `POST` | `/batch-verify` | Verify up to 25 tokens concurrently |
| `GET` | `/user-lookup/:uid` | Look up user profile by UID |
| `GET` | `/metrics` | Prometheus metrics |

### POST /verify

```json
{ "token": "<firebase-id-token>", "check_revoked": false }
```

Returns decoded claims (uid, email, custom_claims, token_metadata) on success. 401 on invalid token.

### POST /batch-verify

```json
{ "tokens": ["<token1>", "<token2>"], "check_revoked": false }
```

Returns per-token results with a summary. Individual failures are reported per-result, not as HTTP errors. Error categories: `expired`, `revoked`, `malformed`, `invalid`.

### GET /user-lookup/:uid

Returns allowlisted user profile fields. Sensitive fields (passwordHash, passwordSalt) are never exposed.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `NODE_ENV` | `development` | Environment (`production`, `development`, `test`) |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | — | Service account JSON key (option 1) |
| `FIREBASE_USE_ADC` | `false` | Use Application Default Credentials (option 2) |
| `FIREBASE_AUTH_EMULATOR_HOST` | — | Firebase Auth Emulator host:port |
| `CORS_ORIGIN` | `true` (allow all) | Allowed CORS origin(s) |
| `BATCH_RATE_LIMIT_MAX` | `100` | Max batch-verify requests per window |
| `BATCH_RATE_LIMIT_WINDOW` | `1 minute` | Rate limit window (Fastify duration string) |

## Running Tests

```bash
pnpm install
pnpm test          # 352 unit tests (mocked Firebase)
pnpm test:coverage # with coverage report
```

## Production Deployment

For production use with real Firebase credentials:

```bash
# Option 1: Service account JSON key
docker run -e FIREBASE_SERVICE_ACCOUNT_JSON='<json>' -p 8080:8080 firebase-auth

# Option 2: Application Default Credentials (Cloud Run with Workload Identity)
docker run -e FIREBASE_USE_ADC=true -p 8080:8080 firebase-auth
```

See `scripts/deploy.sh` for the full GCP deployment pipeline (Cloud Build, digest pinning, IAM, vulnerability scanning).

## Security

- **Helmet**: X-Content-Type-Options, X-Frame-Options, CSP, and other security headers via `@fastify/helmet`
- **CORS**: Configurable origin via `CORS_ORIGIN` env var, defaults to allow-all for development
- **Audit logging**: Structured `audit_log` entries on every response (excludes health/metrics). 500+ errors logged at error level, 401/403 at warn
- **Rate limiting**: Batch endpoint rate-limited via `@fastify/rate-limit` (in-memory LRU)
- **Timing normalization**: Error responses are time-normalized to prevent token validity inference (ADR-010)
- **Log redaction**: UIDs truncated, JWTs/credentials/PEM keys scrubbed from all log output (ADR-007)

## Observability

- **Prometheus metrics**: `GET /metrics` exposes `http_request_duration_seconds` histogram and Node.js default metrics
- **Structured JSON logs**: GCP Cloud Logging compatible via `@google-cloud/pino-logging-gcp-config`
- **Correlation IDs**: Every request gets an `X-Request-ID` header for distributed tracing

## CI

GitHub Actions runs lint, test, and build on every push and PR to main/master.

## Architecture

- **Adapter pattern**: Single Firebase Admin SDK import point. All other modules use the adapter (ADR-001).
- **Fail-fast config**: Missing credentials crash the container at startup, not at first request (ADR-004).
- **Dual credential modes**: SA JSON key or Application Default Credentials via Workload Identity Federation (ADR-019).
- **Graceful shutdown**: SIGTERM/SIGINT handlers drain connections with a 10s force-exit timeout.
- **Version pinning**: All dependencies pinned to exact versions (no carets).

## Architecture Decision Records

23 ADRs document every design choice. See the `decisions/` directory (one level up from this service).

## License

MIT. See [LICENSE](LICENSE).

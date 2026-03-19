# Firebase Auth Verification Service

A production-ready Firebase Authentication verification and user management API built on Fastify.

## Getting Started

### Prerequisites

- Node.js 22.x
- pnpm

### Install

```bash
pnpm install
```

### Configuration

Copy `.env.example` to `.env` and fill in required values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes | -- | Firebase service account JSON |
| `API_KEYS` | Yes | -- | Comma-separated API keys for authentication |
| `PORT` | No | `8080` | Server port |
| `NODE_ENV` | No | `production` | Environment |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `CORS_ORIGIN` | No | Disabled | Allowed CORS origin |
| `RATE_LIMIT_READ` | No | `200` | Read requests/min per API key |
| `RATE_LIMIT_MUTATION` | No | `50` | Mutation requests/min per API key |
| `RATE_LIMIT_BATCH` | No | `20` | Batch requests/min per API key |
| `SESSION_COOKIE_MAX_AGE` | No | `1209600000` | Session cookie max age (ms) |
| `SHUTDOWN_TIMEOUT` | No | `10000` | Graceful shutdown timeout (ms) |

### Development

```bash
pnpm run dev
```

### Build

```bash
pnpm run build
pnpm start
```

## API Endpoints

### Public

- `GET /health` -- Health check with Firebase connectivity status
- `GET /metrics` -- Prometheus metrics (unauthenticated, restrict in production)

### Authenticated (require `X-API-Key` header)

- `POST /verify` -- Verify a Firebase ID token
- `POST /batch-verify` -- Verify multiple tokens (max 25)
- `GET /users/:uid` -- Look up user by UID
- `GET /users/email/:email` -- Look up user by email
- `GET /users/phone/:phone` -- Look up user by phone
- `POST /users/batch` -- Batch user lookup
- `GET /users` -- List users with pagination
- `POST /users` -- Create user
- `PUT /users/:uid` -- Update user
- `DELETE /users/:uid` -- Delete user
- `POST /users/batch-delete` -- Batch delete (max 1000)
- `PUT /users/:uid/claims` -- Set custom claims
- `DELETE /users/:uid/claims` -- Clear custom claims
- `POST /sessions` -- Create session cookie
- `POST /sessions/verify` -- Verify session cookie
- `POST /tokens/custom` -- Mint custom token
- `POST /users/:uid/revoke` -- Revoke refresh tokens
- `POST /email-actions/password-reset` -- Send password reset link
- `POST /email-actions/verify-email` -- Send email verification link
- `POST /email-actions/sign-in` -- Send sign-in link

## Testing

```bash
pnpm test              # run tests
pnpm run test:watch    # watch mode
pnpm run test:coverage # with coverage
```

## Docker

```bash
docker build -t firebase-auth .
docker run -p 8080:8080 --env-file .env firebase-auth
```

Or with Docker Compose:

```bash
docker compose up -d --build
```

## Architecture

Plugins are registered in ADR-005 order: log-redactor, request-context, metrics, api-key-auth, rate-limiter, error-handler, audit-logger. Routes are registered last, after all plugins.

The Firebase Admin SDK is isolated behind an adapter interface (`src/infra/firebase-adapter.ts`) per ADR-001. All route handlers depend on the adapter interface, not the SDK directly.

API key authentication uses constant-time comparison via `crypto.timingSafeEqual`. Key identity is derived as `sha256(key).slice(0, 8)` per ADR-003.

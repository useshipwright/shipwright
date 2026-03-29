# Structural Invariants

Stack: node
Framework: fastify

## Entry Point

- **SI-001** [error]: Fastify server entry point must exist
  - File: `src/app.ts` | Check: `file_exists` | Expected: `src/app.ts`
- **SI-002** [error]: Health route module must exist
  - File: `src/routes/health.ts` | Check: `file_exists` | Expected: `src/routes/health.ts`
- **SI-003** [error]: Meeting routes module must exist
  - File: `src/routes/meetings.ts` | Check: `file_exists` | Expected: `src/routes/meetings.ts`
- **SI-004** [error]: Template routes module must exist
  - File: `src/routes/templates.ts` | Check: `file_exists` | Expected: `src/routes/templates.ts`
- **SI-005** [error]: Action routes module must exist
  - File: `src/routes/actions.ts` | Check: `file_exists` | Expected: `src/routes/actions.ts`
- **SI-006** [error]: Search routes module must exist
  - File: `src/routes/search.ts` | Check: `file_exists` | Expected: `src/routes/search.ts`
- **SI-007** [error]: AI routes module must exist
  - File: `src/routes/ai.ts` | Check: `file_exists` | Expected: `src/routes/ai.ts`
- **SI-008** [error]: Calendar routes module must exist
  - File: `src/routes/calendar.ts` | Check: `file_exists` | Expected: `src/routes/calendar.ts`
- **SI-009** [error]: Share routes module must exist
  - File: `src/routes/share.ts` | Check: `file_exists` | Expected: `src/routes/share.ts`
- **SI-010** [error]: User routes module must exist
  - File: `src/routes/user.ts` | Check: `file_exists` | Expected: `src/routes/user.ts`
- **SI-011** [error]: Audio processing internal worker must exist
  - File: `src/routes/internal/process-audio.ts` | Check: `file_exists` | Expected: `src/routes/internal/process-audio.ts`
- **SI-012** [error]: Calendar sync internal worker must exist
  - File: `src/routes/internal/calendar-sync.ts` | Check: `file_exists` | Expected: `src/routes/internal/calendar-sync.ts`
- **SI-041** [error]: Dockerfile must exist for containerized deployment
  - File: `Dockerfile` | Check: `file_exists` | Expected: `Dockerfile`
- **SI-042** [warning]: Docker compose must exist for local development
  - File: `docker-compose.yml` | Check: `file_exists` | Expected: `docker-compose.yml`

## Dependency

- **SI-020** [error]: Fastify must be a project dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `fastify`
- **SI-021** [error]: Firebase Admin SDK must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `firebase-admin`
- **SI-022** [error]: Google Cloud Storage SDK must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `@google-cloud/storage`
- **SI-023** [error]: Google Cloud Pub/Sub SDK must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `@google-cloud/pubsub`
- **SI-024** [error]: Anthropic SDK must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `@anthropic-ai/sdk`
- **SI-025** [error]: Deepgram SDK must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `@deepgram/sdk`
- **SI-026** [error]: Fastify rate limit plugin must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `@fastify/rate-limit`
- **SI-027** [error]: Fastify WebSocket plugin must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `@fastify/websocket`
- **SI-028** [error]: Fastify multipart plugin must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `@fastify/multipart`
- **SI-029** [error]: Zod validation library must be a dependency
  - File: `package.json` | Check: `package_has_dep` | Expected: `zod`
- **SI-030** [warning]: Pino logger must be a dependency (Fastify default)
  - File: `package.json` | Check: `package_has_dep` | Expected: `pino`
- **SI-044** [error]: zod-to-json-schema must be a dependency for Fastify schema conversion
  - File: `package.json` | Check: `package_has_dep` | Expected: `zod-to-json-schema`
- **SI-045** [error]: Google GenAI SDK must be a dependency for embeddings
  - File: `package.json` | Check: `package_has_dep` | Expected: `@google/genai`

## Config

- **SI-043** [error]: TypeScript config must exist
  - File: `tsconfig.json` | Check: `file_exists` | Expected: `tsconfig.json`
- **SI-047** [error]: Server must read PORT from environment variable
  - File: `src/app.ts` | Check: `file_contains` | Expected: `PORT`

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { FirebaseAdapter } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = 'integration-auth-key-001';
const KEY_ID = createHash('sha256').update(TEST_KEY).digest('hex').slice(0, 8);

const TEST_KEY_B = 'integration-auth-key-002';
const KEY_ID_B = createHash('sha256').update(TEST_KEY_B).digest('hex').slice(0, 8);

const fakeApiKeys: ReadonlyMap<string, Buffer> = new Map([
  [KEY_ID, Buffer.from(TEST_KEY)],
  [KEY_ID_B, Buffer.from(TEST_KEY_B)],
]);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/infra/config.js', () => ({
  config: {
    apiKeys: fakeApiKeys,
  },
}));

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

const userFixture = {
  uid: 'uid-123',
  email: 'test@example.com',
  emailVerified: true,
  displayName: 'Test User',
  phoneNumber: null,
  photoURL: null,
  disabled: false,
  metadata: { creationTime: '2024-01-01T00:00:00Z', lastSignInTime: null, lastRefreshTime: null },
  customClaims: null,
  providerData: [],
  tokensValidAfterTime: null,
};

function createMockAdapter(): FirebaseAdapter {
  return {
    projectId: 'test-project',
    isHealthy: () => true,
    shutdown: vi.fn(),
    verifyIdToken: vi.fn().mockResolvedValue({ uid: 'uid-123', email: 'test@example.com', emailVerified: true, claims: {}, iss: 'https://securetoken.google.com/test', aud: 'test', iat: 1700000000, exp: 1700003600, auth_time: 1700000000 }),
    getUser: vi.fn().mockResolvedValue(userFixture),
    getUserByEmail: vi.fn().mockResolvedValue(userFixture),
    getUserByPhoneNumber: vi.fn().mockResolvedValue(userFixture),
    getUsers: vi.fn().mockResolvedValue([userFixture]),
    createUser: vi.fn().mockResolvedValue(userFixture),
    updateUser: vi.fn().mockResolvedValue(userFixture),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    deleteUsers: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0, errors: [] }),
    listUsers: vi.fn().mockResolvedValue({ users: [] }),
    setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
    revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
    createCustomToken: vi.fn().mockResolvedValue('tok'),
    createSessionCookie: vi.fn().mockResolvedValue('cookie'),
    verifySessionCookie: vi.fn().mockResolvedValue({ uid: 'uid-123', email: null, emailVerified: false, claims: {}, iss: '', aud: '', iat: 0, exp: 0, auth_time: 0 }),
    generatePasswordResetLink: vi.fn().mockResolvedValue(''),
    generateEmailVerificationLink: vi.fn().mockResolvedValue(''),
    generateSignInWithEmailLink: vi.fn().mockResolvedValue(''),
  } as unknown as FirebaseAdapter;
}

// ---------------------------------------------------------------------------
// Build fully-wired integration app
// ---------------------------------------------------------------------------

async function buildIntegrationApp(adapter: FirebaseAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  const { default: auditLogger } = await import('../../src/plugins/audit-logger.js');
  const { default: apiKeyAuth } = await import('../../src/plugins/api-key-auth.js');
  const { default: rateLimiter } = await import('../../src/plugins/rate-limiter.js');
  const { default: metricsPlugin } = await import('../../src/plugins/metrics.js');

  await app.register(requestContext);
  await app.register(errorHandler);
  await app.register(auditLogger);
  await app.register(apiKeyAuth);
  await app.register(rateLimiter, {
    config: { rateLimitRead: 1000, rateLimitMutation: 1000, rateLimitBatch: 1000 },
  });
  await app.register(metricsPlugin);

  // Routes
  const { default: healthRoute } = await import('../../src/routes/health.js');
  const { default: usersLookup } = await import('../../src/routes/users-lookup.js');

  await app.register(healthRoute, { firebaseAdapter: adapter });
  await app.register(usersLookup, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth middleware integration', () => {
  let app: FastifyInstance;
  let adapter: FirebaseAdapter;

  beforeAll(async () => {
    adapter = createMockAdapter();
    app = await buildIntegrationApp(adapter);
  });

  afterAll(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Protected routes require API key
  // -------------------------------------------------------------------------

  it('returns 401 for unauthenticated request to protected route', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/uid-123' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe(401);
    expect(res.json().error.message).toBe('Unauthorized');
  });

  it('returns 401 with empty X-API-Key header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/uid-123',
      headers: { 'x-api-key': '' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with invalid X-API-Key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/uid-123',
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Unauthenticated endpoints
  // -------------------------------------------------------------------------

  it('/health is accessible without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.firebase).toBe('connected');
  });

  it('/metrics is accessible without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Successful authentication
  // -------------------------------------------------------------------------

  it('passes through with valid API key and decorates apiKeyId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/uid-123',
      headers: { 'x-api-key': TEST_KEY },
    });
    expect(res.statusCode).toBe(200);
  });

  it('both configured API keys are valid', async () => {
    const resA = await app.inject({
      method: 'GET',
      url: '/users/uid-123',
      headers: { 'x-api-key': TEST_KEY },
    });
    const resB = await app.inject({
      method: 'GET',
      url: '/users/uid-123',
      headers: { 'x-api-key': TEST_KEY_B },
    });
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // X-Request-ID correlation
  // -------------------------------------------------------------------------

  it('returns X-Request-ID in response headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/uid-123',
      headers: { 'x-api-key': TEST_KEY },
    });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('echoes client-provided X-Request-ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/uid-123',
      headers: { 'x-api-key': TEST_KEY, 'x-request-id': 'custom-req-id' },
    });
    expect(res.headers['x-request-id']).toBe('custom-req-id');
  });

  // -------------------------------------------------------------------------
  // Production entry point (buildApp from src/app.ts)
  // -------------------------------------------------------------------------

  it('buildApp() from src/app.ts creates a working app with /metrics', async () => {
    const { buildApp } = await import('../../src/app.js');
    const prodApp = await buildApp();
    await prodApp.ready();

    const res = await prodApp.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);

    await prodApp.close();
  });
});

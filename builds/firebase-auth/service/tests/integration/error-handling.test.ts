import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { FirebaseAdapter } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = 'error-handling-key-001';
const KEY_ID = createHash('sha256').update(TEST_KEY).digest('hex').slice(0, 8);

const fakeApiKeys: ReadonlyMap<string, Buffer> = new Map([
  [KEY_ID, Buffer.from(TEST_KEY)],
]);

const userFixture = {
  uid: 'uid-123', email: 'test@example.com', emailVerified: true,
  displayName: 'Test', phoneNumber: null, photoURL: null, disabled: false,
  metadata: { creationTime: '2024-01-01T00:00:00Z', lastSignInTime: null, lastRefreshTime: null },
  customClaims: null, providerData: [], tokensValidAfterTime: null,
};

const tokenFixture = {
  uid: 'uid-123', email: 'test@example.com', emailVerified: true,
  claims: {}, iss: 'https://securetoken.google.com/test', aud: 'test',
  iat: 1700000000, exp: 1700003600, auth_time: 1700000000,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/infra/config.js', () => ({
  config: { apiKeys: fakeApiKeys },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firebaseError(code: string, message?: string): Error {
  return Object.assign(new Error(message ?? code), { code });
}

function createMockAdapter(): FirebaseAdapter {
  return {
    projectId: 'test-project',
    isHealthy: () => true,
    shutdown: vi.fn(),
    verifyIdToken: vi.fn().mockResolvedValue(tokenFixture),
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
    verifySessionCookie: vi.fn().mockResolvedValue(tokenFixture),
    generatePasswordResetLink: vi.fn().mockResolvedValue(''),
    generateEmailVerificationLink: vi.fn().mockResolvedValue(''),
    generateSignInWithEmailLink: vi.fn().mockResolvedValue(''),
  } as unknown as FirebaseAdapter;
}

async function buildErrorTestApp(adapter: FirebaseAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  const { default: auditLogger } = await import('../../src/plugins/audit-logger.js');
  const { default: apiKeyAuth } = await import('../../src/plugins/api-key-auth.js');
  const { default: rateLimiter } = await import('../../src/plugins/rate-limiter.js');

  await app.register(requestContext);
  await app.register(errorHandler);
  await app.register(auditLogger);
  await app.register(apiKeyAuth);
  await app.register(rateLimiter, {
    config: { rateLimitRead: 1000, rateLimitMutation: 1000, rateLimitBatch: 1000 },
  });

  const { default: usersLookup } = await import('../../src/routes/users-lookup.js');
  const { default: usersMgmt } = await import('../../src/routes/users-management.js');
  const { default: verifyRoutes } = await import('../../src/routes/verify.js');

  await app.register(usersLookup, { firebaseAdapter: adapter });
  await app.register(usersMgmt, { firebaseAdapter: adapter });
  await app.register(verifyRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

const headers = { 'x-api-key': TEST_KEY };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('error handling integration', () => {
  let app: FastifyInstance;
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeAll(async () => {
    adapter = createMockAdapter();
    app = await buildErrorTestApp(adapter);
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Firebase error code mapping
  // -----------------------------------------------------------------------

  it('maps auth/user-not-found to 404', async () => {
    vi.mocked(adapter.getUser).mockRejectedValueOnce(firebaseError('auth/user-not-found'));

    const res = await app.inject({ method: 'GET', url: '/users/uid-123', headers });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Not found');
  });

  it('maps auth/id-token-expired to 401 with generic message', async () => {
    vi.mocked(adapter.verifyIdToken).mockRejectedValueOnce(firebaseError('auth/id-token-expired'));

    const res = await app.inject({
      method: 'POST', url: '/verify', headers,
      payload: { token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQifQ.c2ln' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Unauthorized');
  });

  it('maps auth/id-token-revoked to 401 with generic message', async () => {
    vi.mocked(adapter.verifyIdToken).mockRejectedValueOnce(firebaseError('auth/id-token-revoked'));

    const res = await app.inject({
      method: 'POST', url: '/verify', headers,
      payload: { token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQifQ.c2ln' },
    });
    expect(res.statusCode).toBe(401);
    // Generic message — no info leakage about revocation
    expect(res.json().error.message).toBe('Unauthorized');
  });

  it('maps auth/email-already-exists to 409', async () => {
    vi.mocked(adapter.createUser).mockRejectedValueOnce(firebaseError('auth/email-already-exists'));

    const res = await app.inject({
      method: 'POST', url: '/users', headers,
      payload: { email: 'dupe@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('maps auth/invalid-email to 400', async () => {
    vi.mocked(adapter.getUser).mockRejectedValueOnce(firebaseError('auth/invalid-email'));

    const res = await app.inject({ method: 'GET', url: '/users/uid-123', headers });
    expect(res.statusCode).toBe(400);
  });

  it('maps auth/insufficient-permission to 500', async () => {
    vi.mocked(adapter.getUser).mockRejectedValueOnce(firebaseError('auth/insufficient-permission'));

    const res = await app.inject({ method: 'GET', url: '/users/uid-123', headers });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe('Internal server error');
  });

  it('maps unknown Firebase errors to 500', async () => {
    vi.mocked(adapter.getUser).mockRejectedValueOnce(firebaseError('auth/unknown-error'));

    const res = await app.inject({ method: 'GET', url: '/users/uid-123', headers });
    expect(res.statusCode).toBe(500);
  });

  // -----------------------------------------------------------------------
  // Error envelope shape
  // -----------------------------------------------------------------------

  it('returns standard error envelope with code, message, and requestId', async () => {
    vi.mocked(adapter.getUser).mockRejectedValueOnce(firebaseError('auth/user-not-found'));

    const res = await app.inject({ method: 'GET', url: '/users/uid-123', headers });
    const body = res.json();

    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 404);
    expect(body.error).toHaveProperty('message');
    expect(body.error).toHaveProperty('requestId');
    expect(typeof body.error.requestId).toBe('string');
  });

  it('includes requestId from X-Request-ID header in error response', async () => {
    vi.mocked(adapter.getUser).mockRejectedValueOnce(firebaseError('auth/user-not-found'));

    const res = await app.inject({
      method: 'GET', url: '/users/uid-123',
      headers: { ...headers, 'x-request-id': 'trace-error-test' },
    });
    expect(res.json().error.requestId).toBe('trace-error-test');
  });

  // -----------------------------------------------------------------------
  // Validation errors
  // -----------------------------------------------------------------------

  it('returns 400 for missing required fields', async () => {
    const res = await app.inject({
      method: 'POST', url: '/verify', headers, payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for malformed JWT structure', async () => {
    const res = await app.inject({
      method: 'POST', url: '/verify', headers,
      payload: { token: 'not-a-jwt' },
    });
    expect(res.statusCode).toBe(400);
  });
});

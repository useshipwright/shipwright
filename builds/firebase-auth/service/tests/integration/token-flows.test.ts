import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { FirebaseAdapter, DecodedToken } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = 'token-flows-key-001';
const KEY_ID = createHash('sha256').update(TEST_KEY).digest('hex').slice(0, 8);

const fakeApiKeys: ReadonlyMap<string, Buffer> = new Map([
  [KEY_ID, Buffer.from(TEST_KEY)],
]);

const headers = { 'x-api-key': TEST_KEY };

// A structurally valid JWT (3 base64url segments)
const VALID_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQtMTIzIn0.c2lnbmF0dXJl';

const decodedToken: DecodedToken = {
  uid: 'uid-123',
  email: 'token@example.com',
  emailVerified: true,
  claims: { role: 'user' },
  iss: 'https://securetoken.google.com/test-project',
  aud: 'test-project',
  iat: 1700000000,
  exp: 1700003600,
  auth_time: 1700000000,
};

const userFixture = {
  uid: 'uid-123', email: 'token@example.com', emailVerified: true,
  displayName: 'Token User', phoneNumber: null, photoURL: null, disabled: false,
  metadata: { creationTime: '2024-01-01T00:00:00Z', lastSignInTime: null, lastRefreshTime: null },
  customClaims: null, providerData: [], tokensValidAfterTime: '2024-06-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/infra/config.js', () => ({
  config: { apiKeys: fakeApiKeys },
}));

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function createMockAdapter(): FirebaseAdapter {
  return {
    projectId: 'test-project',
    isHealthy: () => true,
    shutdown: vi.fn(),
    verifyIdToken: vi.fn().mockResolvedValue(decodedToken),
    getUser: vi.fn().mockResolvedValue(userFixture),
    getUserByEmail: vi.fn(),
    getUserByPhoneNumber: vi.fn(),
    getUsers: vi.fn().mockResolvedValue([]),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    deleteUsers: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0, errors: [] }),
    listUsers: vi.fn().mockResolvedValue({ users: [] }),
    setCustomUserClaims: vi.fn(),
    revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
    createCustomToken: vi.fn().mockResolvedValue('custom-token-abc123'),
    createSessionCookie: vi.fn().mockResolvedValue('session-cookie-xyz789'),
    verifySessionCookie: vi.fn().mockResolvedValue(decodedToken),
    generatePasswordResetLink: vi.fn().mockResolvedValue(''),
    generateEmailVerificationLink: vi.fn().mockResolvedValue(''),
    generateSignInWithEmailLink: vi.fn().mockResolvedValue(''),
  } as unknown as FirebaseAdapter;
}

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

async function buildTokenFlowsApp(adapter: FirebaseAdapter): Promise<FastifyInstance> {
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

  const { default: verifyRoutes } = await import('../../src/routes/verify.js');
  const { default: sessionRoutes } = await import('../../src/routes/sessions.js');
  const { default: tokenRoutes } = await import('../../src/routes/tokens.js');

  await app.register(verifyRoutes, { firebaseAdapter: adapter });
  await app.register(sessionRoutes, { firebaseAdapter: adapter });
  await app.register(tokenRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('token flows integration', () => {
  let app: FastifyInstance;
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeAll(async () => {
    adapter = createMockAdapter();
    app = await buildTokenFlowsApp(adapter);
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Single token verification
  // -----------------------------------------------------------------------

  it('verifies a token and returns decoded claims (POST /verify)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/verify', headers,
      payload: { token: VALID_JWT },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uid).toBe('uid-123');
    expect(body.email).toBe('token@example.com');
    expect(body.claims).toBeDefined();
    expect(adapter.verifyIdToken).toHaveBeenCalledWith(VALID_JWT, false);
  });

  it('verifies a token with checkRevoked=true', async () => {
    const res = await app.inject({
      method: 'POST', url: '/verify', headers,
      payload: { token: VALID_JWT, checkRevoked: true },
    });

    expect(res.statusCode).toBe(200);
    expect(adapter.verifyIdToken).toHaveBeenCalledWith(VALID_JWT, true);
  });

  // -----------------------------------------------------------------------
  // Batch token verification
  // -----------------------------------------------------------------------

  it('batch verifies tokens (POST /batch-verify)', async () => {
    vi.mocked(adapter.verifyIdToken).mockResolvedValueOnce(decodedToken);
    vi.mocked(adapter.verifyIdToken).mockRejectedValueOnce(
      Object.assign(new Error('expired'), { code: 'auth/id-token-expired' }),
    );

    const res = await app.inject({
      method: 'POST', url: '/batch-verify', headers,
      payload: {
        tokens: [
          { token: VALID_JWT },
          { token: VALID_JWT, checkRevoked: true },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].valid).toBe(true);
    expect(body.results[1].valid).toBe(false);
    expect(body.summary.total).toBe(2);
    expect(body.summary.valid).toBe(1);
    expect(body.summary.invalid).toBe(1);
  });

  it('rejects batch with more than 25 tokens', async () => {
    const tokens = Array.from({ length: 26 }, () => ({ token: VALID_JWT }));

    const res = await app.inject({
      method: 'POST', url: '/batch-verify', headers,
      payload: { tokens },
    });

    expect(res.statusCode).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Custom token minting
  // -----------------------------------------------------------------------

  it('mints a custom token (POST /tokens/custom)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/tokens/custom', headers,
      payload: { uid: 'uid-123', claims: { role: 'admin' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().customToken).toBe('custom-token-abc123');
    expect(res.json().uid).toBe('uid-123');
    expect(adapter.createCustomToken).toHaveBeenCalledWith('uid-123', { role: 'admin' });
  });

  it('mints a custom token without claims', async () => {
    const res = await app.inject({
      method: 'POST', url: '/tokens/custom', headers,
      payload: { uid: 'uid-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(adapter.createCustomToken).toHaveBeenCalledWith('uid-123', undefined);
  });

  // -----------------------------------------------------------------------
  // Session cookie creation and verification
  // -----------------------------------------------------------------------

  it('creates a session cookie (POST /sessions)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/sessions', headers,
      payload: { idToken: 'some-id-token', expiresIn: 604800000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionCookie).toBe('session-cookie-xyz789');
    expect(res.json().expiresIn).toBe(604800000);
    expect(adapter.createSessionCookie).toHaveBeenCalledWith('some-id-token', 604800000);
  });

  it('verifies a session cookie (POST /sessions/verify)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/sessions/verify', headers,
      payload: { sessionCookie: 'session-cookie-xyz789' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().uid).toBe('uid-123');
    expect(adapter.verifySessionCookie).toHaveBeenCalledWith('session-cookie-xyz789', false);
  });

  it('rejects session with expiresIn below minimum (5 min)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/sessions', headers,
      payload: { idToken: 'tok', expiresIn: 299999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects session with expiresIn above maximum (14 days)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/sessions', headers,
      payload: { idToken: 'tok', expiresIn: 1209600001 },
    });
    expect(res.statusCode).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Token revocation
  // -----------------------------------------------------------------------

  it('revokes refresh tokens (POST /users/:uid/revoke)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/users/uid-123/revoke', headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tokensValidAfterTime).toBe('2024-06-01T00:00:00Z');
    expect(adapter.revokeRefreshTokens).toHaveBeenCalledWith('uid-123');
    expect(adapter.getUser).toHaveBeenCalledWith('uid-123');
  });
});

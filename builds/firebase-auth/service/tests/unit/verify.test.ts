import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FirebaseAdapter, DecodedToken } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ0ZXN0In0.c2lnbmF0dXJl';

const DECODED_TOKEN: DecodedToken = {
  uid: 'user-123',
  email: 'test@example.com',
  emailVerified: true,
  claims: { role: 'admin' },
  iss: 'https://securetoken.google.com/test-project',
  aud: 'test-project',
  iat: 1700000000,
  exp: 1700003600,
  auth_time: 1700000000,
};

function firebaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function mockAdapter(overrides: Partial<FirebaseAdapter> = {}): FirebaseAdapter {
  return {
    projectId: 'test-project',
    isHealthy: () => true,
    shutdown: async () => {},
    verifyIdToken: vi.fn().mockResolvedValue(DECODED_TOKEN),
    getUser: async () => ({} as never),
    getUserByEmail: async () => ({} as never),
    getUserByPhoneNumber: async () => ({} as never),
    getUsers: async () => [],
    createUser: async () => ({} as never),
    updateUser: async () => ({} as never),
    deleteUser: async () => {},
    deleteUsers: async () => ({ successCount: 0, failureCount: 0, errors: [] }),
    listUsers: async () => ({ users: [] }),
    setCustomUserClaims: async () => {},
    revokeRefreshTokens: async () => {},
    createCustomToken: async () => '',
    createSessionCookie: async () => '',
    verifySessionCookie: async () => ({} as never),
    generatePasswordResetLink: async () => '',
    generateEmailVerificationLink: async () => '',
    generateSignInWithEmailLink: async () => '',
    ...overrides,
  };
}

async function buildTestApp(adapter: FirebaseAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Decorate with requestId and apiKeyId so routes can use them
  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  // Error handler for Firebase errors
  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  const { default: verifyRoutes } = await import('../../src/routes/verify.js');
  await app.register(verifyRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verify routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // POST /verify — single token verification
  // -----------------------------------------------------------------------

  describe('POST /verify', () => {
    it('returns decoded token for a valid JWT', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.uid).toBe('user-123');
      expect(body.email).toBe('test@example.com');
      expect(body.claims).toEqual({ role: 'admin' });
    });

    it('passes checkRevoked to Firebase SDK', async () => {
      const verifyIdToken = vi.fn().mockResolvedValue(DECODED_TOKEN);
      const adapter = mockAdapter({ verifyIdToken });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT, checkRevoked: true },
      });

      expect(verifyIdToken).toHaveBeenCalledWith(VALID_JWT, true);
    });

    it('returns 400 when token is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(400);
      expect(body.error.message).toContain('token');
    });

    it('returns 400 when token is empty string', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for malformed JWT (not 3 segments)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: 'not-a-jwt' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('3 dot-separated');
    });

    it('returns 400 for JWT with only 2 segments', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: 'part1.part2' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 when Firebase reports expired token', async () => {
      const adapter = mockAdapter({
        verifyIdToken: vi.fn().mockRejectedValue(
          firebaseError('auth/id-token-expired', 'Token expired'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      expect(res.statusCode).toBe(401);
      // Generic message — no "expired" detail leaked
      expect(res.json().error.message).toBe('Unauthorized');
    });

    it('returns 401 when Firebase reports revoked token with checkRevoked=true', async () => {
      const adapter = mockAdapter({
        verifyIdToken: vi.fn().mockRejectedValue(
          firebaseError('auth/id-token-revoked', 'Token revoked'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT, checkRevoked: true },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Unauthorized');
    });

    it('error response has standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: 'bad' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // POST /batch-verify
  // -----------------------------------------------------------------------

  describe('POST /batch-verify', () => {
    it('verifies multiple tokens and returns per-token results with summary', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
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
      expect(body.results[0].uid).toBe('user-123');
      expect(body.summary.total).toBe(2);
      expect(body.summary.valid).toBe(2);
      expect(body.summary.invalid).toBe(0);
    });

    it('handles mix of valid and invalid tokens', async () => {
      const verifyIdToken = vi.fn()
        .mockResolvedValueOnce(DECODED_TOKEN)
        .mockRejectedValueOnce(firebaseError('auth/id-token-expired', 'expired'));
      const adapter = mockAdapter({ verifyIdToken });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: {
          tokens: [
            { token: VALID_JWT },
            { token: VALID_JWT },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary.valid).toBe(1);
      expect(body.summary.invalid).toBe(1);
      expect(body.results[1].valid).toBe(false);
      expect(body.results[1].error).toBeDefined();
    });

    it('returns 200 even when all tokens are invalid', async () => {
      const verifyIdToken = vi.fn().mockRejectedValue(
        firebaseError('auth/id-token-expired', 'expired'),
      );
      const adapter = mockAdapter({ verifyIdToken });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: {
          tokens: [{ token: VALID_JWT }, { token: VALID_JWT }],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().summary.valid).toBe(0);
      expect(res.json().summary.invalid).toBe(2);
    });

    it('returns 400 when tokens array is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('tokens');
    });

    it('returns 400 when tokens array is empty', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('at least one');
    });

    it('accepts exactly 25 tokens (max boundary)', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const tokens = Array.from({ length: 25 }, () => ({ token: VALID_JWT }));
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().summary.total).toBe(25);
    });

    it('rejects 26 tokens with 400', async () => {
      app = await buildTestApp(mockAdapter());

      const tokens = Array.from({ length: 26 }, () => ({ token: VALID_JWT }));
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('exceeds');
    });

    it('marks malformed JWTs as invalid without calling Firebase SDK', async () => {
      const verifyIdToken = vi.fn().mockResolvedValue(DECODED_TOKEN);
      const adapter = mockAdapter({ verifyIdToken });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: {
          tokens: [
            { token: 'not-a-jwt' },
            { token: VALID_JWT },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.results[0].valid).toBe(false);
      expect(body.results[1].valid).toBe(true);
      // Only the valid JWT should have called the SDK
      expect(verifyIdToken).toHaveBeenCalledTimes(1);
    });

    it('error response has standard envelope shape on batch failures', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });
});

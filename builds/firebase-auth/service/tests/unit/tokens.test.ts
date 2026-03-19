import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FirebaseAdapter, UserProfile } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_FIXTURE: UserProfile = {
  uid: 'user-abc',
  email: 'alice@example.com',
  emailVerified: false,
  displayName: 'Alice',
  phoneNumber: '+14155551234',
  photoURL: null,
  disabled: false,
  metadata: {
    creationTime: '2024-01-01T00:00:00Z',
    lastSignInTime: null,
    lastRefreshTime: null,
  },
  customClaims: null,
  providerData: [],
  tokensValidAfterTime: '2024-06-01T00:00:00Z',
};

function firebaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function mockAdapter(overrides: Partial<FirebaseAdapter> = {}): FirebaseAdapter {
  return {
    projectId: 'test-project',
    isHealthy: () => true,
    shutdown: async () => {},
    verifyIdToken: async () => ({} as never),
    getUser: vi.fn().mockResolvedValue(USER_FIXTURE),
    getUserByEmail: async () => ({} as never),
    getUserByPhoneNumber: async () => ({} as never),
    getUsers: async () => [],
    createUser: async () => ({} as never),
    updateUser: async () => ({} as never),
    deleteUser: async () => {},
    deleteUsers: async () => ({ successCount: 0, failureCount: 0, errors: [] }),
    listUsers: async () => ({ users: [] }),
    setCustomUserClaims: async () => {},
    revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
    createCustomToken: vi.fn().mockResolvedValue('custom-token-value'),
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

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  const { default: auditLogger } = await import('../../src/plugins/audit-logger.js');
  await app.register(auditLogger);

  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  const { default: tokenRoutes } = await import('../../src/routes/tokens.js');
  await app.register(tokenRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('token routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // POST /tokens/custom — mint custom token
  // -----------------------------------------------------------------------

  describe('POST /tokens/custom', () => {
    it('mints a custom token and returns 200', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.customToken).toBe('custom-token-value');
      expect(body.uid).toBe('user-abc');
    });

    it('passes claims to createCustomToken when provided', async () => {
      const createCustomToken = vi.fn().mockResolvedValue('token');
      const adapter = mockAdapter({ createCustomToken });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc', claims: { role: 'admin' } },
      });

      expect(createCustomToken).toHaveBeenCalledWith('user-abc', { role: 'admin' });
    });

    it('creates token without claims when not provided', async () => {
      const createCustomToken = vi.fn().mockResolvedValue('token');
      const adapter = mockAdapter({ createCustomToken });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc' },
      });

      expect(createCustomToken).toHaveBeenCalledWith('user-abc', undefined);
    });

    it('returns 400 when uid is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('uid');
    });

    it('returns 400 when uid is empty string', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when uid exceeds 128 characters', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'x'.repeat(129) },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts uid of exactly 128 characters', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'x'.repeat(128) },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when claims is not an object', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc', claims: 'not-an-object' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when claims is an array', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc', claims: [1, 2, 3] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when claims is null', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc', claims: null },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for reserved claim name "sub"', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc', claims: { sub: 'value' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('reserved');
    });

    it('returns 400 when claims exceed 1000 chars serialized', async () => {
      app = await buildTestApp(mockAdapter());

      const overhead = '{"k":""}'; // 8 chars
      const padLen = 1001 - overhead.length;
      const claims = { k: 'x'.repeat(padLen) };

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc', claims },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('1000');
    });

    it('accepts claims exactly at 1000 chars serialized', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const overhead = '{"k":""}';
      const padLen = 1000 - overhead.length;
      const claims = { k: 'x'.repeat(padLen) };
      expect(JSON.stringify(claims).length).toBe(1000);

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc', claims },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 500 when Firebase reports insufficient permission', async () => {
      const adapter = mockAdapter({
        createCustomToken: vi.fn().mockRejectedValue(
          firebaseError('auth/insufficient-permission', 'Missing iam.serviceAccounts.signBlob'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: { uid: 'user-abc' },
      });

      expect(res.statusCode).toBe(500);
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/tokens/custom',
        payload: {},
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // POST /users/:uid/revoke — revoke refresh tokens
  // -----------------------------------------------------------------------

  describe('POST /users/:uid/revoke', () => {
    it('revokes tokens and returns tokensValidAfterTime', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/user-abc/revoke',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().tokensValidAfterTime).toBe('2024-06-01T00:00:00Z');
    });

    it('calls revokeRefreshTokens then getUser', async () => {
      const revokeRefreshTokens = vi.fn().mockResolvedValue(undefined);
      const getUser = vi.fn().mockResolvedValue(USER_FIXTURE);
      const adapter = mockAdapter({ revokeRefreshTokens, getUser });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/users/user-abc/revoke',
      });

      expect(revokeRefreshTokens).toHaveBeenCalledWith('user-abc');
      expect(getUser).toHaveBeenCalledWith('user-abc');
    });

    it('emits audit event on revocation', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'POST',
        url: '/users/user-abc/revoke',
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'tokens.revoked',
          target: 'user-abc',
          changes: { fields: ['refreshTokens'] },
        }),
      );
    });

    it('returns 404 when user not found', async () => {
      const adapter = mockAdapter({
        revokeRefreshTokens: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/nonexistent/revoke',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for UID > 100 chars (Fastify maxParamLength)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: `/users/${'x'.repeat(101)}/revoke`,
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

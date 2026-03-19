import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FirebaseAdapter, DecodedToken } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    verifyIdToken: async () => ({} as never),
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
    createSessionCookie: vi.fn().mockResolvedValue('session-cookie-value'),
    verifySessionCookie: vi.fn().mockResolvedValue(DECODED_TOKEN),
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

  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  const { default: sessionRoutes } = await import('../../src/routes/sessions.js');
  await app.register(sessionRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // POST /sessions — create session cookie
  // -----------------------------------------------------------------------

  describe('POST /sessions', () => {
    it('creates a session cookie with valid idToken and expiresIn', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'valid-id-token', expiresIn: 604800000 },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionCookie).toBe('session-cookie-value');
      expect(body.expiresIn).toBe(604800000);
    });

    it('calls createSessionCookie with correct arguments', async () => {
      const createSessionCookie = vi.fn().mockResolvedValue('cookie');
      const adapter = mockAdapter({ createSessionCookie });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'my-token', expiresIn: 300000 },
      });

      expect(createSessionCookie).toHaveBeenCalledWith('my-token', 300000);
    });

    it('returns 400 when idToken is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { expiresIn: 604800000 },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('idToken');
    });

    it('returns 400 when idToken is empty string', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: '', expiresIn: 604800000 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when expiresIn is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'valid-token' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('expiresIn');
    });

    it('returns 400 when expiresIn is below 5 minutes (299999ms)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'valid-token', expiresIn: 299999 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts expiresIn exactly at 5 minutes (300000ms)', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'valid-token', expiresIn: 300000 },
      });

      expect(res.statusCode).toBe(200);
    });

    it('accepts expiresIn exactly at 14 days (1209600000ms)', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'valid-token', expiresIn: 1209600000 },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when expiresIn exceeds 14 days (1209600001ms)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'valid-token', expiresIn: 1209600001 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when expiresIn is not a number', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'valid-token', expiresIn: 'not-a-number' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 when Firebase reports expired token', async () => {
      const adapter = mockAdapter({
        createSessionCookie: vi.fn().mockRejectedValue(
          firebaseError('auth/id-token-expired', 'Token expired'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { idToken: 'expired-token', expiresIn: 604800000 },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Unauthorized');
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: {},
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // POST /sessions/verify — verify session cookie
  // -----------------------------------------------------------------------

  describe('POST /sessions/verify', () => {
    it('verifies a session cookie and returns decoded token', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: { sessionCookie: 'valid-cookie' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.uid).toBe('user-123');
      expect(body.email).toBe('test@example.com');
    });

    it('passes checkRevoked=false by default', async () => {
      const verifySessionCookie = vi.fn().mockResolvedValue(DECODED_TOKEN);
      const adapter = mockAdapter({ verifySessionCookie });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: { sessionCookie: 'valid-cookie' },
      });

      expect(verifySessionCookie).toHaveBeenCalledWith('valid-cookie', false);
    });

    it('passes checkRevoked=true when specified', async () => {
      const verifySessionCookie = vi.fn().mockResolvedValue(DECODED_TOKEN);
      const adapter = mockAdapter({ verifySessionCookie });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: { sessionCookie: 'valid-cookie', checkRevoked: true },
      });

      expect(verifySessionCookie).toHaveBeenCalledWith('valid-cookie', true);
    });

    it('returns 400 when sessionCookie is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('sessionCookie');
    });

    it('returns 400 when sessionCookie is empty string', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: { sessionCookie: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns error when session cookie is revoked', async () => {
      const adapter = mockAdapter({
        verifySessionCookie: vi.fn().mockRejectedValue(
          firebaseError('auth/session-cookie-revoked', 'Cookie revoked'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: { sessionCookie: 'revoked-cookie', checkRevoked: true },
      });

      // auth/session-cookie-revoked is not in error handler exact map;
      // falls through to default 500
      expect(res.statusCode).toBe(500);
    });

    it('returns error when session cookie is expired', async () => {
      const adapter = mockAdapter({
        verifySessionCookie: vi.fn().mockRejectedValue(
          firebaseError('auth/session-cookie-expired', 'Cookie expired'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: { sessionCookie: 'expired-cookie' },
      });

      // auth/session-cookie-expired is not in error handler exact map;
      // falls through to default 500
      expect(res.statusCode).toBe(500);
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/sessions/verify',
        payload: {},
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });
});

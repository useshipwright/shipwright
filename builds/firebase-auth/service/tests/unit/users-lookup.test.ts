import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FirebaseAdapter, UserProfile } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_FIXTURE: UserProfile = {
  uid: 'user-abc',
  email: 'alice@example.com',
  emailVerified: true,
  displayName: 'Alice',
  phoneNumber: '+14155551234',
  photoURL: null,
  disabled: false,
  metadata: {
    creationTime: '2024-01-01T00:00:00Z',
    lastSignInTime: '2024-06-01T00:00:00Z',
    lastRefreshTime: null,
  },
  customClaims: null,
  providerData: [],
  tokensValidAfterTime: null,
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
    getUserByEmail: vi.fn().mockResolvedValue(USER_FIXTURE),
    getUserByPhoneNumber: vi.fn().mockResolvedValue(USER_FIXTURE),
    getUsers: vi.fn().mockResolvedValue([USER_FIXTURE]),
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

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  const { default: usersLookupRoutes } = await import('../../src/routes/users-lookup.js');
  await app.register(usersLookupRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('users-lookup routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // GET /users/:uid
  // -----------------------------------------------------------------------

  describe('GET /users/:uid', () => {
    it('returns user profile for a valid UID', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({ method: 'GET', url: '/users/user-abc' });

      expect(res.statusCode).toBe(200);
      expect(res.json().uid).toBe('user-abc');
      expect(res.json().email).toBe('alice@example.com');
    });

    it('returns 404 for UID > 100 chars (Fastify maxParamLength)', async () => {
      app = await buildTestApp(mockAdapter());

      // Fastify's default maxParamLength=100 causes a route mismatch (404)
      // before the handler's UID validator runs
      const longUid = 'a'.repeat(101);
      const res = await app.inject({ method: 'GET', url: `/users/${longUid}` });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when Firebase reports user-not-found', async () => {
      const adapter = mockAdapter({
        getUser: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({ method: 'GET', url: '/users/nonexistent' });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe(404);
    });

    it('error response follows standard envelope shape', async () => {
      const adapter = mockAdapter({
        getUser: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({ method: 'GET', url: '/users/nonexistent' });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // GET /users/by-email/:email
  // -----------------------------------------------------------------------

  describe('GET /users/by-email/:email', () => {
    it('returns user profile for valid email', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: '/users/by-email/alice@example.com',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().uid).toBe('user-abc');
    });

    it('returns 400 for invalid email format', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: '/users/by-email/notanemail',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('email');
    });

    it('handles URL-encoded email with special chars (user+tag@example.com)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: `/users/by-email/${encodeURIComponent('user+tag@example.com')}`,
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when Firebase reports user-not-found', async () => {
      const adapter = mockAdapter({
        getUserByEmail: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'GET',
        url: '/users/by-email/unknown@example.com',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // GET /users/by-phone/:phoneNumber
  // -----------------------------------------------------------------------

  describe('GET /users/by-phone/:phoneNumber', () => {
    it('returns user profile for valid E.164 phone', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: `/users/by-phone/${encodeURIComponent('+14155551234')}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().uid).toBe('user-abc');
    });

    it('returns 400 for phone without + prefix', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: '/users/by-phone/14155551234',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('E.164');
    });

    it('returns 400 for phone with letters', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: `/users/by-phone/${encodeURIComponent('+1415abc5678')}`,
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // POST /users/batch
  // -----------------------------------------------------------------------

  describe('POST /users/batch', () => {
    it('returns found users and notFound identifiers', async () => {
      const adapter = mockAdapter({
        getUsers: vi.fn().mockResolvedValue([USER_FIXTURE]),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: {
          identifiers: [
            { uid: 'user-abc' },
            { uid: 'does-not-exist' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.users).toHaveLength(1);
      expect(body.notFound).toHaveLength(1);
      expect(body.notFound[0].uid).toBe('does-not-exist');
    });

    it('returns 400 when identifiers array is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('identifiers');
    });

    it('returns 400 when identifiers array is empty', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: { identifiers: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts exactly 100 identifiers', async () => {
      const adapter = mockAdapter({
        getUsers: vi.fn().mockResolvedValue([]),
      });
      app = await buildTestApp(adapter);

      const identifiers = Array.from({ length: 100 }, (_, i) => ({ uid: `u${i}` }));
      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: { identifiers },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects 101 identifiers with 400', async () => {
      app = await buildTestApp(mockAdapter());

      const identifiers = Array.from({ length: 101 }, (_, i) => ({ uid: `u${i}` }));
      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: { identifiers },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('exceeds');
    });

    it('validates each identifier has exactly one key', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: {
          identifiers: [{ uid: 'abc', email: 'a@b.com' }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('exactly one key');
    });

    it('validates email format within batch identifiers', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: {
          identifiers: [{ email: 'invalid-email' }],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('supports mixed identifier types (uid, email, phoneNumber)', async () => {
      const adapter = mockAdapter({
        getUsers: vi.fn().mockResolvedValue([USER_FIXTURE]),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch',
        payload: {
          identifiers: [
            { uid: 'user-abc' },
            { email: 'alice@example.com' },
            { phoneNumber: '+14155551234' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});

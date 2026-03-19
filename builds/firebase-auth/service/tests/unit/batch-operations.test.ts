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
    getUser: async () => ({} as never),
    getUserByEmail: async () => ({} as never),
    getUserByPhoneNumber: async () => ({} as never),
    getUsers: async () => [],
    createUser: async () => ({} as never),
    updateUser: async () => ({} as never),
    deleteUser: async () => {},
    deleteUsers: vi.fn().mockResolvedValue({
      successCount: 3,
      failureCount: 0,
      errors: [],
    }),
    listUsers: vi.fn().mockResolvedValue({
      users: [USER_FIXTURE],
      pageToken: undefined,
    }),
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

  const { default: auditLogger } = await import('../../src/plugins/audit-logger.js');
  await app.register(auditLogger);

  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  const { default: batchOperationsRoutes } = await import('../../src/routes/batch-operations.js');
  await app.register(batchOperationsRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('batch-operations routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // POST /users/batch-delete — bulk delete
  // -----------------------------------------------------------------------

  describe('POST /users/batch-delete', () => {
    it('deletes users and returns success/failure counts', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids: ['uid1', 'uid2', 'uid3'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.successCount).toBe(3);
      expect(body.failureCount).toBe(0);
      expect(body.errors).toEqual([]);
    });

    it('passes uids array to deleteUsers', async () => {
      const deleteUsers = vi.fn().mockResolvedValue({
        successCount: 2, failureCount: 0, errors: [],
      });
      const adapter = mockAdapter({ deleteUsers });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids: ['uid1', 'uid2'] },
      });

      expect(deleteUsers).toHaveBeenCalledWith(['uid1', 'uid2']);
    });

    it('returns partial failure results correctly', async () => {
      const adapter = mockAdapter({
        deleteUsers: vi.fn().mockResolvedValue({
          successCount: 2,
          failureCount: 1,
          errors: [{ index: 1, error: { code: 'auth/user-not-found', message: 'User not found' } }],
        }),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids: ['uid1', 'uid2', 'uid3'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.successCount).toBe(2);
      expect(body.failureCount).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].index).toBe(1);
      expect(body.errors[0].message).toBe('User not found');
    });

    it('emits audit event on batch delete', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids: ['uid1', 'uid2', 'uid3'] },
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'users.batch_deleted',
          changes: { fields: ['uids'] },
        }),
      );
    });

    it('returns 400 when uids is not an array', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids: 'not-an-array' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('array');
    });

    it('returns 400 when uids is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when uids array is empty', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids: [] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('empty');
    });

    it('accepts exactly 1000 uids (max boundary)', async () => {
      const adapter = mockAdapter({
        deleteUsers: vi.fn().mockResolvedValue({
          successCount: 1000, failureCount: 0, errors: [],
        }),
      });
      app = await buildTestApp(adapter);

      const uids = Array.from({ length: 1000 }, (_, i) => `uid-${i}`);
      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects 1001 uids with 400', async () => {
      app = await buildTestApp(mockAdapter());

      const uids = Array.from({ length: 1001 }, (_, i) => `uid-${i}`);
      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('1000');
    });

    it('returns 400 when uids array contains non-string entries', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: { uids: ['uid1', 123, 'uid3'] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('uids[1]');
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users/batch-delete',
        payload: {},
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // GET /users — paginated listing
  // -----------------------------------------------------------------------

  describe('GET /users', () => {
    it('returns paginated user list', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'GET',
        url: '/users',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.users).toHaveLength(1);
      expect(body.users[0].uid).toBe('user-abc');
    });

    it('defaults maxResults to 1000', async () => {
      const listUsers = vi.fn().mockResolvedValue({ users: [], pageToken: undefined });
      const adapter = mockAdapter({ listUsers });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'GET',
        url: '/users',
      });

      expect(listUsers).toHaveBeenCalledWith(1000, undefined);
    });

    it('passes maxResults and pageToken when specified', async () => {
      const listUsers = vi.fn().mockResolvedValue({ users: [], pageToken: undefined });
      const adapter = mockAdapter({ listUsers });
      app = await buildTestApp(adapter);

      await app.inject({
        method: 'GET',
        url: '/users?maxResults=50&pageToken=abc123',
      });

      expect(listUsers).toHaveBeenCalledWith(50, 'abc123');
    });

    it('includes pageToken in response when more pages exist', async () => {
      const adapter = mockAdapter({
        listUsers: vi.fn().mockResolvedValue({
          users: [USER_FIXTURE],
          pageToken: 'next-page-token',
        }),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'GET',
        url: '/users',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().pageToken).toBe('next-page-token');
    });

    it('omits pageToken when no more pages', async () => {
      const adapter = mockAdapter({
        listUsers: vi.fn().mockResolvedValue({
          users: [USER_FIXTURE],
          pageToken: undefined,
        }),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'GET',
        url: '/users',
      });

      expect(res.statusCode).toBe(200);
      // pageToken should be absent or undefined
      expect(res.json().pageToken).toBeUndefined();
    });

    it('returns 400 when maxResults is 0', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: '/users?maxResults=0',
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when maxResults exceeds 1000', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: '/users?maxResults=1001',
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when maxResults is not a number', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'GET',
        url: '/users?maxResults=abc',
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts maxResults of exactly 1000', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'GET',
        url: '/users?maxResults=1000',
      });

      expect(res.statusCode).toBe(200);
    });

    it('accepts maxResults of exactly 1', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'GET',
        url: '/users?maxResults=1',
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when Firebase reports invalid page token', async () => {
      const adapter = mockAdapter({
        listUsers: vi.fn().mockRejectedValue(
          firebaseError('auth/invalid-page-token', 'Invalid page token'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'GET',
        url: '/users?pageToken=invalid',
      });

      expect(res.statusCode).toBe(400);
    });
  });
});

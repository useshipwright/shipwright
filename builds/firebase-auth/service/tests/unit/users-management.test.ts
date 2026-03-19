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
    createUser: vi.fn().mockResolvedValue(USER_FIXTURE),
    updateUser: vi.fn().mockResolvedValue(USER_FIXTURE),
    deleteUser: vi.fn().mockResolvedValue(undefined),
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

  const { default: auditLogger } = await import('../../src/plugins/audit-logger.js');
  await app.register(auditLogger);

  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  const { default: usersManagementRoutes } = await import('../../src/routes/users-management.js');
  await app.register(usersManagementRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('users-management routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // POST /users — create
  // -----------------------------------------------------------------------

  describe('POST /users', () => {
    it('creates a user and returns 201', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'new@example.com', password: 'secret123' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().uid).toBe('user-abc');
    });

    it('emits audit event on user creation', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const auditSpy = vi.spyOn(app, 'emitAudit');

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'new@example.com', password: 'secret123' },
      });

      expect(res.statusCode).toBe(201);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'user.created',
          target: 'user-abc',
          changes: expect.objectContaining({
            fields: expect.arrayContaining(['email', 'password']),
          }),
        }),
      );
    });

    it('returns 400 for invalid email', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for short password (< 6 chars)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'a@b.com', password: '12345' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('6 characters');
    });

    it('returns 400 for invalid phone number', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { phoneNumber: 'not-e164' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 409 when email already exists', async () => {
      const adapter = mockAdapter({
        createUser: vi.fn().mockRejectedValue(
          firebaseError('auth/email-already-exists', 'Email already in use'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'taken@example.com', password: 'secret123' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('returns 409 when phone number already exists', async () => {
      const adapter = mockAdapter({
        createUser: vi.fn().mockRejectedValue(
          firebaseError('auth/phone-number-already-exists', 'Phone in use'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { phoneNumber: '+14155551234', password: 'secret123' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('password field never appears in response body', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'new@example.com', password: 'secret123' },
      });

      expect(JSON.stringify(res.json())).not.toContain('secret123');
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'invalid' },
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // PATCH /users/:uid — update
  // -----------------------------------------------------------------------

  describe('PATCH /users/:uid', () => {
    it('updates a user and returns 200', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PATCH',
        url: '/users/user-abc',
        payload: { displayName: 'Bob' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('emits audit event with changed field names', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'PATCH',
        url: '/users/user-abc',
        payload: { displayName: 'Bob', email: 'bob@example.com' },
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'user.updated',
          target: 'user-abc',
          changes: expect.objectContaining({
            fields: expect.arrayContaining(['displayName', 'email']),
          }),
        }),
      );
    });

    it('returns 400 when no valid fields are provided', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PATCH',
        url: '/users/user-abc',
        payload: { unknownField: 'value' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('No valid fields');
    });

    it('returns 404 for UID > 100 chars (Fastify maxParamLength)', async () => {
      app = await buildTestApp(mockAdapter());

      const longUid = 'a'.repeat(101);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${longUid}`,
        payload: { displayName: 'Test' },
      });

      // Fastify default maxParamLength=100 causes route mismatch before handler
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when user not found', async () => {
      const adapter = mockAdapter({
        updateUser: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'PATCH',
        url: '/users/nonexistent',
        payload: { displayName: 'Test' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /users/:uid
  // -----------------------------------------------------------------------

  describe('DELETE /users/:uid', () => {
    it('deletes a user and returns 204', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'DELETE',
        url: '/users/user-abc',
      });

      expect(res.statusCode).toBe(204);
    });

    it('emits audit event on deletion', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'DELETE',
        url: '/users/user-abc',
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'user.deleted',
          target: 'user-abc',
          changes: { fields: [] },
        }),
      );
    });

    it('returns 404 when user not found', async () => {
      const adapter = mockAdapter({
        deleteUser: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'DELETE',
        url: '/users/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for UID > 100 chars (Fastify maxParamLength)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${'x'.repeat(101)}`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // POST /users/:uid/disable
  // -----------------------------------------------------------------------

  describe('POST /users/:uid/disable', () => {
    it('disables a user and returns 200', async () => {
      const updateUser = vi.fn().mockResolvedValue({ ...USER_FIXTURE, disabled: true });
      const adapter = mockAdapter({ updateUser });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/user-abc/disable',
      });

      expect(res.statusCode).toBe(200);
      expect(updateUser).toHaveBeenCalledWith('user-abc', { disabled: true });
    });

    it('emits audit event for disable', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'POST',
        url: '/users/user-abc/disable',
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'user.disabled',
          changes: { fields: ['disabled'] },
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // POST /users/:uid/enable
  // -----------------------------------------------------------------------

  describe('POST /users/:uid/enable', () => {
    it('enables a user and returns 200', async () => {
      const updateUser = vi.fn().mockResolvedValue({ ...USER_FIXTURE, disabled: false });
      const adapter = mockAdapter({ updateUser });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/users/user-abc/enable',
      });

      expect(res.statusCode).toBe(200);
      expect(updateUser).toHaveBeenCalledWith('user-abc', { disabled: false });
    });

    it('emits audit event for enable', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'POST',
        url: '/users/user-abc/enable',
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'user.enabled',
          changes: { fields: ['disabled'] },
        }),
      );
    });
  });
});

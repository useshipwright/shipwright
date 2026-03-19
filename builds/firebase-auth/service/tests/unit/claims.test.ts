import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FirebaseAdapter } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
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

  const { default: claimsRoutes } = await import('../../src/routes/claims.js');
  await app.register(claimsRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claims routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // PUT /users/:uid/claims — set custom claims
  // -----------------------------------------------------------------------

  describe('PUT /users/:uid/claims', () => {
    it('sets claims and returns 200 with claims object', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: { role: 'admin', level: 5 } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().claims).toEqual({ role: 'admin', level: 5 });
      expect(adapter.setCustomUserClaims).toHaveBeenCalledWith(
        'user-abc',
        { role: 'admin', level: 5 },
      );
    });

    it('emits audit event with claim field names', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: { role: 'admin', tier: 'premium' } },
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'claims.set',
          target: 'user-abc',
          changes: { fields: ['role', 'tier'] },
        }),
      );
    });

    it('accepts empty object {} as valid claims', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: {} },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when claims is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('claims');
    });

    it('returns 400 when claims is null', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: null },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when claims is an array', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: [1, 2, 3] },
      });

      expect(res.statusCode).toBe(400);
    });

    // Claims size validation — 1000 characters per ADR-009

    it('accepts claims exactly at 1000 chars serialized', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      // Build a claims object whose JSON.stringify is exactly 1000 chars
      // {"k":"..."} where the value pad length fills up to 1000
      const overhead = '{"k":""}';  // 8 chars
      const padLen = 1000 - overhead.length;
      const claims = { k: 'x'.repeat(padLen) };
      expect(JSON.stringify(claims).length).toBe(1000);

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects claims exceeding 1000 chars serialized', async () => {
      app = await buildTestApp(mockAdapter());

      const overhead = '{"k":""}';
      const padLen = 1001 - overhead.length;
      const claims = { k: 'x'.repeat(padLen) };
      expect(JSON.stringify(claims).length).toBe(1001);

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('1000');
    });

    // Reserved claim names

    it('rejects reserved claim name "sub"', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: { sub: 'value' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('reserved');
    });

    it('rejects reserved claim name "iss"', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: { iss: 'value' } },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects reserved claim name "aud"', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: { aud: 'value' } },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects reserved claim name "firebase"', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: { claims: { firebase: 'value' } },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for UID > 100 chars (Fastify maxParamLength)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: `/users/${'z'.repeat(101)}/claims`,
        payload: { claims: { role: 'admin' } },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when Firebase reports user-not-found', async () => {
      const adapter = mockAdapter({
        setCustomUserClaims: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'PUT',
        url: '/users/nonexistent/claims',
        payload: { claims: { role: 'admin' } },
      });

      expect(res.statusCode).toBe(404);
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'PUT',
        url: '/users/user-abc/claims',
        payload: {},
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /users/:uid/claims — remove all custom claims
  // -----------------------------------------------------------------------

  describe('DELETE /users/:uid/claims', () => {
    it('deletes claims using null and returns 204', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'DELETE',
        url: '/users/user-abc/claims',
      });

      expect(res.statusCode).toBe(204);
      expect(adapter.setCustomUserClaims).toHaveBeenCalledWith('user-abc', null);
    });

    it('emits audit event for claims deletion', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);
      const auditSpy = vi.spyOn(app, 'emitAudit');

      await app.inject({
        method: 'DELETE',
        url: '/users/user-abc/claims',
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'claims.deleted',
          target: 'user-abc',
          changes: { fields: [] },
        }),
      );
    });

    it('returns 404 for UID > 100 chars (Fastify maxParamLength)', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${'z'.repeat(101)}/claims`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when Firebase reports user-not-found', async () => {
      const adapter = mockAdapter({
        setCustomUserClaims: vi.fn().mockRejectedValue(
          firebaseError('auth/user-not-found', 'User not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'DELETE',
        url: '/users/nonexistent/claims',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

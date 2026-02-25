/**
 * Integration tests for the app factory (app.ts).
 *
 * Verifies buildApp() assembles the plugin graph correctly:
 * - skipFirebaseInit: true → only /health route registered
 * - skipFirebaseInit: false → all 4 routes registered (mock adapter)
 * - Duplicate buildApp() calls create independent instances
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mock the firebase-admin adapter so buildApp({ skipFirebaseInit: false })
// does not require real Firebase credentials (ADR-001)
const mockInitFirebase = vi.fn();
const mockGetFirebaseAuth = vi.fn();

vi.mock('../src/adapters/firebase-admin.js', () => ({
  initFirebase: mockInitFirebase,
  getFirebaseAuth: mockGetFirebaseAuth,
}));

const { buildApp } = await import('../src/app.js');

const VALID_SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key: 'fake-key',
  client_email: 'sa@test.iam.gserviceaccount.com',
});

describe('buildApp — app factory', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    savedEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = savedEnv;
    } else {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    }
  });

  describe('skipFirebaseInit: true', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      await app.close();
    });

    it('registers only /health route', async () => {
      app = await buildApp({ skipFirebaseInit: true });
      await app.ready();

      const healthRes = await app.inject({ method: 'GET', url: '/health' });
      expect(healthRes.statusCode).toBe(200);

      const verifyRes = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: 'a.b.c' },
      });
      expect(verifyRes.statusCode).toBe(404);

      const batchRes = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: ['a.b.c'] },
      });
      expect(batchRes.statusCode).toBe(404);

      const userRes = await app.inject({
        method: 'GET',
        url: '/user-lookup/test-uid',
      });
      expect(userRes.statusCode).toBe(404);
    });

    it('does not call initFirebase', async () => {
      app = await buildApp({ skipFirebaseInit: true });
      await app.ready();

      expect(mockInitFirebase).not.toHaveBeenCalled();
      expect(mockGetFirebaseAuth).not.toHaveBeenCalled();
    });

    it('does not have firebaseAuth decorator', async () => {
      app = await buildApp({ skipFirebaseInit: true });
      await app.ready();

      expect(app.hasDecorator('firebaseAuth')).toBe(false);
    });
  });

  describe('skipFirebaseInit: false (default)', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      await app.close();
    });

    it('registers all 4 routes when Firebase init succeeds', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      app = await buildApp();
      await app.ready();

      // /health should respond 200
      const healthRes = await app.inject({ method: 'GET', url: '/health' });
      expect(healthRes.statusCode).toBe(200);

      // /verify should NOT be 404 (it exists — will return 400 for bad input)
      const verifyRes = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: {},
      });
      expect(verifyRes.statusCode).not.toBe(404);

      // /batch-verify should NOT be 404
      const batchRes = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: {},
      });
      expect(batchRes.statusCode).not.toBe(404);

      // /user-lookup/:uid — mock getUser to return a valid user record
      fakeAuth.getUser.mockResolvedValue({
        uid: 'testuid123',
        email: 'test@example.com',
        emailVerified: true,
        disabled: false,
        customClaims: null,
        providerData: [],
        metadata: {
          creationTime: '2025-01-01T00:00:00Z',
          lastSignInTime: '2025-01-01T00:00:00Z',
          lastRefreshTime: null,
        },
      });
      const userRes = await app.inject({
        method: 'GET',
        url: '/user-lookup/testuid123',
      });
      expect(userRes.statusCode).toBe(200);
    });

    it('calls initFirebase with credential from env', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      app = await buildApp();
      await app.ready();

      expect(mockInitFirebase).toHaveBeenCalledWith(VALID_SA_JSON);
    });

    it('decorates app with firebaseAuth', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      app = await buildApp();
      await app.ready();

      expect(app.hasDecorator('firebaseAuth')).toBe(true);
      expect(app.firebaseAuth).toBe(fakeAuth);
    });

    it('rejects request bodies exceeding bodyLimit with 413', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      app = await buildApp();
      await app.ready();

      // 2 MiB payload exceeds Fastify's default 1 MiB bodyLimit
      const oversizedBody = JSON.stringify({ token: 'x'.repeat(2 * 1024 * 1024) });

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        headers: { 'content-type': 'application/json' },
        body: oversizedBody,
      });

      expect(res.statusCode).toBe(413);
    });

    it('health reports firebase_initialized: true when Firebase is initialized', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      app = await buildApp();
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(res.body);
      expect(body.firebase_initialized).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('plugin dependency order', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      await app.close();
    });

    it('returns Fastify instance without calling listen()', async () => {
      app = await buildApp({ skipFirebaseInit: true });
      // app should be returnable and usable without listen()
      await app.ready();
      expect(app).toBeDefined();
    });

    it('registers correlation-id plugin (X-Request-ID propagation)', async () => {
      app = await buildApp({ skipFirebaseInit: true });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('propagates incoming X-Request-ID header', async () => {
      app = await buildApp({ skipFirebaseInit: true });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': 'test-trace-id-42' },
      });
      expect(res.headers['x-request-id']).toBe('test-trace-id-42');
    });
  });

  describe('independent instances', () => {
    it('duplicate buildApp() calls create independent instances', async () => {
      const app1 = await buildApp({ skipFirebaseInit: true });
      const app2 = await buildApp({ skipFirebaseInit: true });

      await app1.ready();
      await app2.ready();

      expect(app1).not.toBe(app2);

      await app1.close();
      await app2.close();
    });
  });
});

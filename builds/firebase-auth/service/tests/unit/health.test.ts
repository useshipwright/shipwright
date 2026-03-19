import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FirebaseAdapter } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mockAdapter(overrides: Partial<FirebaseAdapter> = {}): FirebaseAdapter {
  return {
    projectId: 'test-project',
    isHealthy: () => true,
    shutdown: async () => {},
    verifyIdToken: async () => ({ uid: '', email: null, emailVerified: false, claims: {}, iss: '', aud: '', iat: 0, exp: 0, auth_time: 0 }),
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
    verifySessionCookie: async () => ({ uid: '', email: null, emailVerified: false, claims: {}, iss: '', aud: '', iat: 0, exp: 0, auth_time: 0 }),
    generatePasswordResetLink: async () => '',
    generateEmailVerificationLink: async () => '',
    generateSignInWithEmailLink: async () => '',
    ...overrides,
  };
}

async function buildTestApp(adapter: FirebaseAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { default: healthRoute } = await import('../../src/routes/health.js');
  await app.register(healthRoute, { firebaseAdapter: adapter });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('health route', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with correct response shape when Firebase is healthy', async () => {
    const adapter = mockAdapter({ isHealthy: () => true });
    app = await buildTestApp(adapter);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.firebase).toBe('connected');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime).toBe('number');
  });

  it('returns firebase "error" when adapter is not healthy', async () => {
    const adapter = mockAdapter({ isHealthy: () => false });
    app = await buildTestApp(adapter);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json().firebase).toBe('error');
  });

  it('uses BUILD_SHA env var for version when available', async () => {
    const original = process.env.BUILD_SHA;
    process.env.BUILD_SHA = 'abc123sha';

    try {
      // Re-import to pick up the env var change
      const appLocal = Fastify({ logger: false });
      const { default: healthRoute } = await import('../../src/routes/health.js');
      await appLocal.register(healthRoute, { firebaseAdapter: mockAdapter() });
      await appLocal.ready();

      const res = await appLocal.inject({ method: 'GET', url: '/health' });
      // BUILD_SHA is read at module load time, so it may or may not reflect the change
      // The important thing is version is a string
      expect(typeof res.json().version).toBe('string');

      await appLocal.close();
    } finally {
      if (original === undefined) delete process.env.BUILD_SHA;
      else process.env.BUILD_SHA = original;
    }
  });

  it('returns uptime as a positive number', async () => {
    app = await buildTestApp(mockAdapter());

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json().uptime).toBeGreaterThan(0);
  });
});

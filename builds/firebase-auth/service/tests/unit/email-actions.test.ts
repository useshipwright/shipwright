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
    setCustomUserClaims: async () => {},
    revokeRefreshTokens: async () => {},
    createCustomToken: async () => '',
    createSessionCookie: async () => '',
    verifySessionCookie: async () => ({} as never),
    generatePasswordResetLink: vi.fn().mockResolvedValue('https://example.com/reset'),
    generateEmailVerificationLink: vi.fn().mockResolvedValue('https://example.com/verify'),
    generateSignInWithEmailLink: vi.fn().mockResolvedValue('https://example.com/sign-in'),
    ...overrides,
  };
}

async function buildTestApp(adapter: FirebaseAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  const { default: emailActionRoutes } = await import('../../src/routes/email-actions.js');
  await app.register(emailActionRoutes, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('email-action routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // POST /email-actions/password-reset
  // -----------------------------------------------------------------------

  describe('POST /email-actions/password-reset', () => {
    it('generates a password reset link and returns 200', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/password-reset',
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().link).toBe('https://example.com/reset');
    });

    it('passes actionCodeSettings to SDK when provided', async () => {
      const generatePasswordResetLink = vi.fn().mockResolvedValue('https://link');
      const adapter = mockAdapter({ generatePasswordResetLink });
      app = await buildTestApp(adapter);

      const actionCodeSettings = { url: 'https://continue.example.com' };
      await app.inject({
        method: 'POST',
        url: '/email-actions/password-reset',
        payload: { email: 'user@example.com', actionCodeSettings },
      });

      expect(generatePasswordResetLink).toHaveBeenCalledWith(
        'user@example.com',
        actionCodeSettings,
      );
    });

    it('returns 400 when email is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/password-reset',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('email');
    });

    it('returns 400 when email is empty string', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/password-reset',
        payload: { email: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid email format', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/password-reset',
        payload: { email: 'not-an-email' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns error when Firebase reports email not found', async () => {
      const adapter = mockAdapter({
        generatePasswordResetLink: vi.fn().mockRejectedValue(
          firebaseError('auth/email-not-found', 'Email not found'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/password-reset',
        payload: { email: 'unknown@example.com' },
      });

      // auth/email-not-found is not in error handler exact map;
      // falls through to default 500
      expect(res.statusCode).toBe(500);
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/password-reset',
        payload: {},
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });

  // -----------------------------------------------------------------------
  // POST /email-actions/verification
  // -----------------------------------------------------------------------

  describe('POST /email-actions/verification', () => {
    it('generates an email verification link and returns 200', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/verification',
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().link).toBe('https://example.com/verify');
    });

    it('passes actionCodeSettings to SDK when provided', async () => {
      const generateEmailVerificationLink = vi.fn().mockResolvedValue('https://link');
      const adapter = mockAdapter({ generateEmailVerificationLink });
      app = await buildTestApp(adapter);

      const actionCodeSettings = { url: 'https://continue.example.com' };
      await app.inject({
        method: 'POST',
        url: '/email-actions/verification',
        payload: { email: 'user@example.com', actionCodeSettings },
      });

      expect(generateEmailVerificationLink).toHaveBeenCalledWith(
        'user@example.com',
        actionCodeSettings,
      );
    });

    it('returns 400 when email is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/verification',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('email');
    });

    it('returns 400 for invalid email format', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/verification',
        payload: { email: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // POST /email-actions/sign-in
  // -----------------------------------------------------------------------

  describe('POST /email-actions/sign-in', () => {
    const VALID_ACTION_CODE_SETTINGS = {
      url: 'https://example.com/finish-sign-in',
      handleCodeInApp: true,
    };

    it('generates a sign-in link and returns 200', async () => {
      const adapter = mockAdapter();
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: {
          email: 'user@example.com',
          actionCodeSettings: VALID_ACTION_CODE_SETTINGS,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().link).toBe('https://example.com/sign-in');
    });

    it('passes actionCodeSettings with extra fields to SDK', async () => {
      const generateSignInWithEmailLink = vi.fn().mockResolvedValue('https://link');
      const adapter = mockAdapter({ generateSignInWithEmailLink });
      app = await buildTestApp(adapter);

      const settings = {
        url: 'https://example.com/callback',
        handleCodeInApp: true,
        iOS: { bundleId: 'com.example.app' },
        android: { packageName: 'com.example.app', installApp: true },
        dynamicLinkDomain: 'example.page.link',
      };

      await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: { email: 'user@example.com', actionCodeSettings: settings },
      });

      expect(generateSignInWithEmailLink).toHaveBeenCalledWith('user@example.com', settings);
    });

    it('returns 400 when email is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: { actionCodeSettings: VALID_ACTION_CODE_SETTINGS },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('email');
    });

    it('returns 400 for invalid email format', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: {
          email: 'not-an-email',
          actionCodeSettings: VALID_ACTION_CODE_SETTINGS,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when actionCodeSettings is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('actionCodeSettings');
    });

    it('returns 400 when actionCodeSettings.url is missing', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: {
          email: 'user@example.com',
          actionCodeSettings: { handleCodeInApp: true },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('url');
    });

    it('returns 400 when handleCodeInApp is false', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: {
          email: 'user@example.com',
          actionCodeSettings: {
            url: 'https://example.com/callback',
            handleCodeInApp: false,
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('handleCodeInApp');
    });

    it('returns 400 when handleCodeInApp is not provided', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: {
          email: 'user@example.com',
          actionCodeSettings: { url: 'https://example.com/callback' },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('handleCodeInApp');
    });

    it('returns 400 when Firebase reports invalid continue URI', async () => {
      const adapter = mockAdapter({
        generateSignInWithEmailLink: vi.fn().mockRejectedValue(
          firebaseError('auth/invalid-continue-uri', 'Invalid continue URI'),
        ),
      });
      app = await buildTestApp(adapter);

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: {
          email: 'user@example.com',
          actionCodeSettings: {
            url: 'not-a-url',
            handleCodeInApp: true,
          },
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('error response follows standard envelope shape', async () => {
      app = await buildTestApp(mockAdapter());

      const res = await app.inject({
        method: 'POST',
        url: '/email-actions/sign-in',
        payload: {},
      });

      const body = res.json();
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });
  });
});

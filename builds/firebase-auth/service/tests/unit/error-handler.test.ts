import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock config — needed for buildApp integration test
// ---------------------------------------------------------------------------

vi.mock('../../src/infra/config.js', () => {
  const { createHash } = require('node:crypto');
  const TEST_KEY = 'error-handler-test-key';
  const keyId = createHash('sha256').update(TEST_KEY).digest('hex').slice(0, 8);
  return {
    config: {
      serviceAccountCredential: { project_id: 'test' },
      apiKeys: new Map([[keyId, Buffer.from(TEST_KEY)]]),
      port: 8080,
      logLevel: 'silent',
      rateLimitRead: 200,
      rateLimitMutation: 50,
      rateLimitBatch: 20,
      sessionCookieMaxAge: 1_209_600_000,
      shutdownTimeout: 10_000,
      nodeEnv: 'test',
      corsOrigin: null,
      trustProxy: false,
      skipFirebaseHealthProbe: true,
      buildSha: null,
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a Firebase-like error with a code property. */
function firebaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Create a network-level error. */
function networkError(code: string): Error {
  return Object.assign(new Error(`Network error: ${code}`), { code });
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Request context provides requestId for error responses
  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  // Error handler under test
  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  await app.register(errorHandler);

  // Routes that throw various errors for testing
  app.get('/firebase-error', async (request) => {
    const code = (request.query as { code?: string }).code ?? 'auth/user-not-found';
    throw firebaseError(code, `Firebase: ${code}`);
  });

  app.get('/network-error', async (request) => {
    const code = (request.query as { code?: string }).code ?? 'ECONNREFUSED';
    throw networkError(code);
  });

  app.get('/validation-error', async () => {
    const err = Object.assign(new Error('body must have required property'), {
      validation: [{ keyword: 'required', params: { missingProperty: 'token' } }],
      statusCode: 400,
    });
    throw err;
  });

  app.get('/unknown-error', async () => {
    throw new Error('Something unexpected');
  });

  app.get('/error-with-status', async () => {
    const err = Object.assign(new Error('Not found'), { statusCode: 404 });
    throw err;
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Unit tests — plugin in isolation
// ---------------------------------------------------------------------------

describe('error-handler plugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Standard error response shape
  // -----------------------------------------------------------------------

  describe('standard error response shape', () => {
    it('returns { error: { code, message, requestId } } on all errors', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/unknown-error',
      });

      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('requestId');
    });

    it('includes requestId from request context', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/unknown-error',
        headers: { 'x-request-id': 'test-req-123' },
      });

      expect(res.json().error.requestId).toBe('test-req-123');
    });

    it('never includes stack trace in error response', async () => {
      const res = await app.inject({ method: 'GET', url: '/unknown-error' });
      const body = JSON.stringify(res.json());
      expect(body).not.toContain('at ');
      expect(body).not.toContain('.ts:');
    });
  });

  // -----------------------------------------------------------------------
  // Firebase error code → HTTP status mapping
  // -----------------------------------------------------------------------

  describe('Firebase error code → HTTP status mapping', () => {
    const cases: [string, number][] = [
      ['auth/user-not-found', 404],
      ['auth/id-token-expired', 401],
      ['auth/id-token-revoked', 401],
      ['auth/insufficient-permission', 500],
      ['auth/quota-exceeded', 503],
      ['auth/internal-error', 502],
      ['auth/invalid-email', 400],
      ['auth/invalid-argument', 400],
      ['auth/invalid-password', 400],
      ['auth/invalid-phone-number', 400],
      ['auth/email-already-exists', 409],
      ['auth/phone-number-already-exists', 409],
    ];

    for (const [firebaseCode, expectedStatus] of cases) {
      it(`maps ${firebaseCode} → ${expectedStatus}`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/firebase-error?code=${encodeURIComponent(firebaseCode)}`,
        });

        expect(res.statusCode).toBe(expectedStatus);
        expect(res.json().error.code).toBe(expectedStatus);
      });
    }

    it('maps unknown Firebase error codes to 500', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/firebase-error?code=auth/some-unknown-code',
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // Generic messages for 401/403 (no info leakage)
  // -----------------------------------------------------------------------

  describe('generic messages for 401/403', () => {
    it('returns generic "Unauthorized" for auth/id-token-expired', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/firebase-error?code=auth/id-token-expired',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Unauthorized');
      // Must NOT contain "expired" in the client message
      expect(res.json().error.message).not.toContain('expired');
    });

    it('returns generic "Unauthorized" for auth/id-token-revoked', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/firebase-error?code=auth/id-token-revoked',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Unauthorized');
      expect(res.json().error.message).not.toContain('revoked');
    });
  });

  // -----------------------------------------------------------------------
  // Network errors → 502
  // -----------------------------------------------------------------------

  describe('network errors', () => {
    const networkCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];

    for (const code of networkCodes) {
      it(`maps network error ${code} → 502`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/network-error?code=${code}`,
        });

        expect(res.statusCode).toBe(502);
        expect(res.json().error.message).toBe('Bad gateway');
      });
    }
  });

  // -----------------------------------------------------------------------
  // Fastify validation errors → 400
  // -----------------------------------------------------------------------

  describe('validation errors', () => {
    it('maps Fastify validation error → 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/validation-error',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Unknown / catch-all errors
  // -----------------------------------------------------------------------

  describe('unknown errors', () => {
    it('returns 500 for unrecognised errors with generic message', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/unknown-error',
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toBe('Internal server error');
    });

    it('uses existing statusCode from error if present', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/error-with-status',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration test — verify error handler wired via production entry point
// ---------------------------------------------------------------------------

describe('error-handler via buildApp (production wiring)', () => {
  let app: FastifyInstance;
  const TEST_API_KEY = 'error-handler-test-key';

  beforeEach(async () => {
    const { buildApp } = await import('../../src/app.js');
    app = await buildApp();

    // Add a test route that throws a Firebase error to exercise the error handler
    app.get('/test-firebase-error', async () => {
      throw firebaseError('auth/user-not-found', 'user not found');
    });

    app.get('/test-unknown-error', async () => {
      throw new Error('unexpected');
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('uses the Firebase-aware error handler, not the legacy errors.ts handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-firebase-error',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    // The plugin error handler returns { error: { code, message, requestId } }
    // The legacy errors.ts would return { statusCode, error, message }
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 404);
    expect(body.error).toHaveProperty('message', 'Not found');
    expect(body.error).toHaveProperty('requestId');

    // Must NOT have the legacy errors.ts shape
    expect(body).not.toHaveProperty('statusCode');
  });

  it('returns generic message for 500 errors via production wiring', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-unknown-error',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe('Internal server error');
    // No stack trace or internal detail leakage
    expect(JSON.stringify(res.json())).not.toContain('unexpected');
  });
});

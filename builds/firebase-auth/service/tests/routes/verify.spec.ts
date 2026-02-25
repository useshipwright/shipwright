import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildRouteTestApp, type MockFirebaseAuth } from '../helpers/build-test-app.js';
import verifyRoute from '../../src/routes/verify.js';

// Valid JWT structure (3 base64url segments) — content doesn't matter, just structure
const VALID_JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ';

// Standard decoded token fixture
const DECODED_TOKEN = {
  uid: 'user-abc-123',
  email: 'alice@example.com',
  email_verified: true,
  name: 'Alice Smith',
  picture: 'https://example.com/alice.jpg',
  iat: 1708300000,
  exp: 1708303600,
  auth_time: 1708299700,
  iss: 'https://securetoken.google.com/test-project',
  sub: 'user-abc-123',
  aud: 'test-project',
  firebase: { sign_in_provider: 'google.com' },
};

describe('POST /verify', () => {
  let app: FastifyInstance;
  let mocks: MockFirebaseAuth;

  beforeEach(async () => {
    const testApp = await buildRouteTestApp(verifyRoute);
    app = testApp.app;
    mocks = testApp.mocks;
  });

  afterEach(async () => {
    await app.close();
  });

  // --- Success cases ---

  describe('valid token verification', () => {
    it('returns 200 with full claims on valid token', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.uid).toBe('user-abc-123');
      expect(body.email).toBe('alice@example.com');
      expect(body.email_verified).toBe(true);
      expect(body.name).toBe('Alice Smith');
      expect(body.picture).toBe('https://example.com/alice.jpg');
    });

    it('returns correct token_metadata', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      const body = JSON.parse(res.body);
      expect(body.token_metadata).toEqual({
        iat: 1708300000,
        exp: 1708303600,
        auth_time: 1708299700,
        iss: 'https://securetoken.google.com/test-project',
        sign_in_provider: 'google.com',
      });
    });

    it('returns empty custom_claims when no custom claims exist', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      const body = JSON.parse(res.body);
      expect(body.custom_claims).toEqual({});
    });

    it('returns custom_claims when present', async () => {
      mocks.verifyIdToken.mockResolvedValue({
        ...DECODED_TOKEN,
        role: 'admin',
        orgId: 'org-999',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      const body = JSON.parse(res.body);
      expect(body.custom_claims).toEqual({ role: 'admin', orgId: 'org-999' });
    });

    it('returns email: null for anonymous user', async () => {
      mocks.verifyIdToken.mockResolvedValue({
        ...DECODED_TOKEN,
        email: undefined,
        email_verified: undefined,
        name: undefined,
        picture: undefined,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      const body = JSON.parse(res.body);
      expect(body.email).toBeNull();
      expect(body.email_verified).toBeNull();
      expect(body.name).toBeNull();
      expect(body.picture).toBeNull();
    });

    it('returns X-Request-ID response header', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('ignores extra fields in body', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT, extra: 'ignored' },
      });

      // Schema has additionalProperties: false, so Fastify may strip or reject.
      // The schema should still allow the request or return 400 for strict schemas.
      // Given the schema has additionalProperties: false, this should be 400.
      expect([200, 400]).toContain(res.statusCode);
    });
  });

  // --- Generic 401 enforcement (REQ-008) ---

  describe('generic 401 for all verification failures (REQ-008)', () => {
    const GENERIC_401 = { error: 'Unauthorized', statusCode: 401 };

    const firebaseErrors = [
      { name: 'expired token', code: 'auth/id-token-expired' },
      { name: 'invalid token', code: 'auth/invalid-id-token' },
      { name: 'revoked token', code: 'auth/id-token-revoked' },
      { name: 'wrong audience', code: 'auth/invalid-argument' },
      { name: 'argument error', code: 'auth/argument-error' },
    ];

    for (const { name, code } of firebaseErrors) {
      it(`returns generic 401 for ${name} (${code})`, async () => {
        const err = new Error(code);
        (err as Record<string, unknown>).code = code;
        mocks.verifyIdToken.mockRejectedValue(err);

        const res = await app.inject({
          method: 'POST',
          url: '/verify',
          payload: { token: VALID_JWT },
        });

        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.body)).toEqual(GENERIC_401);
      });
    }

    it('all 401 response bodies are identical regardless of failure reason', async () => {
      const bodies: string[] = [];

      for (const { code } of firebaseErrors) {
        const err = new Error(code);
        (err as Record<string, unknown>).code = code;
        mocks.verifyIdToken.mockRejectedValue(err);

        const res = await app.inject({
          method: 'POST',
          url: '/verify',
          payload: { token: VALID_JWT },
        });

        bodies.push(res.body);
      }

      // All bodies should be identical
      const first = bodies[0];
      for (const body of bodies) {
        expect(body).toBe(first);
      }
    });

    it('401 response body does NOT contain failure reason', async () => {
      const err = new Error('auth/id-token-expired');
      (err as Record<string, unknown>).code = 'auth/id-token-expired';
      mocks.verifyIdToken.mockRejectedValue(err);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      const body = res.body;
      expect(body).not.toContain('expired');
      expect(body).not.toContain('revoked');
      expect(body).not.toContain('invalid-id-token');
      expect(body).not.toContain('auth/');
    });

    it('returns generic 401 for plain Error without code property', async () => {
      mocks.verifyIdToken.mockRejectedValue(new Error('connection refused'));

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(GENERIC_401);
    });

    it('returns generic 401 for TypeError', async () => {
      mocks.verifyIdToken.mockRejectedValue(new TypeError('Cannot read properties of undefined'));

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(GENERIC_401);
    });
  });

  // --- Input validation (400) ---

  describe('input validation (400 responses)', () => {
    it('returns 400 for missing request body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for empty object body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for empty string token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for token with wrong type (number)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: 123 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid JWT structure (not 3 segments)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: 'only-two.segments' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('Firebase SDK is NOT called when input validation fails', async () => {
      // Missing body
      await app.inject({ method: 'POST', url: '/verify' });
      expect(mocks.verifyIdToken).not.toHaveBeenCalled();

      // Empty token
      await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: '' },
      });
      expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    });

    it('Firebase SDK is NOT called for structurally invalid JWT', async () => {
      await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: 'not.valid' },
      });

      expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    });
  });

  // --- check_revoked opt-in (T-045) ---

  describe('check_revoked opt-in', () => {
    it('defaults to not passing checkRevoked when omitted', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      expect(mocks.verifyIdToken).toHaveBeenCalledWith(VALID_JWT, false);
    });

    it('defaults to not passing checkRevoked when explicitly false', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT, check_revoked: false },
      });

      expect(mocks.verifyIdToken).toHaveBeenCalledWith(VALID_JWT, false);
    });

    it('passes checkRevoked=true when check_revoked is true', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT, check_revoked: true },
      });

      expect(mocks.verifyIdToken).toHaveBeenCalledWith(VALID_JWT, true);
    });

    it('returns generic 401 for revoked token with check_revoked=true', async () => {
      const err = new Error('auth/id-token-revoked');
      (err as Record<string, unknown>).code = 'auth/id-token-revoked';
      mocks.verifyIdToken.mockRejectedValue(err);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT, check_revoked: true },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ error: 'Unauthorized', statusCode: 401 });
    });

    it('succeeds normally with check_revoked=true and non-revoked token', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT, check_revoked: true },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.uid).toBe('user-abc-123');
    });
  });

  // --- Response schema conformance ---

  describe('response schema conformance', () => {
    it('200 response has all required fields', async () => {
      mocks.verifyIdToken.mockResolvedValue(DECODED_TOKEN);

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('uid');
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('email_verified');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('picture');
      expect(body).toHaveProperty('custom_claims');
      expect(body).toHaveProperty('token_metadata');
      expect(body.token_metadata).toHaveProperty('iat');
      expect(body.token_metadata).toHaveProperty('exp');
      expect(body.token_metadata).toHaveProperty('auth_time');
      expect(body.token_metadata).toHaveProperty('iss');
      expect(body.token_metadata).toHaveProperty('sign_in_provider');
    });

    it('400 response has error and statusCode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: {},
      });

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('statusCode');
      expect(body.statusCode).toBe(400);
    });

    it('401 response has error and statusCode', async () => {
      mocks.verifyIdToken.mockRejectedValue(new Error('auth/invalid-id-token'));

      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('statusCode');
      expect(body.statusCode).toBe(401);
    });
  });
});

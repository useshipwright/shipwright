import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildRouteTestApp, type MockFirebaseAuth } from '../helpers/build-test-app.js';
import batchVerifyRoute from '../../src/routes/batch-verify.js';

// Valid JWT structures (3 base64url segments) — content doesn't matter
const VALID_JWT_A =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEifQ.c2lnbmF0dXJlQQ';
const VALID_JWT_B =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWIifQ.c2lnbmF0dXJlQg';
const VALID_JWT_C =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWMifQ.c2lnbmF0dXJlQw';

const MALFORMED_TOKEN = 'not-a-jwt-at-all';

function makeDecodedToken(uid: string, email: string) {
  return {
    uid,
    email,
    email_verified: true,
    name: `User ${uid}`,
    picture: null,
    iat: 1708300000,
    exp: 1708303600,
    auth_time: 1708299700,
    iss: 'https://securetoken.google.com/test-project',
    sub: uid,
    aud: 'test-project',
    firebase: { sign_in_provider: 'google.com' },
  };
}

function makeFirebaseError(code: string): Error {
  const err = new Error(code);
  (err as Record<string, unknown>).code = code;
  return err;
}

describe('POST /batch-verify', () => {
  let app: FastifyInstance;
  let mocks: MockFirebaseAuth;

  beforeEach(async () => {
    const testApp = await buildRouteTestApp(batchVerifyRoute);
    app = testApp.app;
    mocks = testApp.mocks;
  });

  afterEach(async () => {
    await app.close();
  });

  // --- Success cases ---

  describe('all tokens valid', () => {
    it('returns 200 with all results valid', async () => {
      mocks.verifyIdToken.mockImplementation(async (token: string) => {
        if (token === VALID_JWT_A) return makeDecodedToken('user-a', 'a@example.com');
        if (token === VALID_JWT_B) return makeDecodedToken('user-b', 'b@example.com');
        return makeDecodedToken('user-c', 'c@example.com');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A, VALID_JWT_B, VALID_JWT_C] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toHaveLength(3);
      expect(body.results.every((r: { valid: boolean }) => r.valid)).toBe(true);
      expect(body.summary).toEqual({ total: 3, valid: 3, invalid: 0 });
    });

    it('returns correct claims for each valid result', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      const body = JSON.parse(res.body);
      const result = body.results[0];
      expect(result.valid).toBe(true);
      expect(result.uid).toBe('user-a');
      expect(result.email).toBe('a@example.com');
      expect(result.token_metadata).toHaveProperty('iat');
      expect(result.token_metadata).toHaveProperty('exp');
      expect(result.token_metadata).toHaveProperty('sign_in_provider');
    });
  });

  describe('all tokens invalid', () => {
    it('returns 200 with all results invalid', async () => {
      mocks.verifyIdToken.mockRejectedValue(makeFirebaseError('auth/invalid-id-token'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A, VALID_JWT_B] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results.every((r: { valid: boolean }) => !r.valid)).toBe(true);
      expect(body.summary).toEqual({ total: 2, valid: 0, invalid: 2 });
    });
  });

  describe('mixed valid and invalid tokens', () => {
    it('returns correct per-token results', async () => {
      mocks.verifyIdToken.mockImplementation(async (token: string) => {
        if (token === VALID_JWT_A) return makeDecodedToken('user-a', 'a@example.com');
        throw makeFirebaseError('auth/id-token-expired');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A, VALID_JWT_B] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results[0].valid).toBe(true);
      expect(body.results[0].uid).toBe('user-a');
      expect(body.results[1].valid).toBe(false);
      expect(body.results[1].error).toBe('expired');
      expect(body.summary).toEqual({ total: 2, valid: 1, invalid: 1 });
    });

    it('results are in same order as input tokens', async () => {
      mocks.verifyIdToken.mockImplementation(async (token: string) => {
        if (token === VALID_JWT_A) return makeDecodedToken('user-a', 'a@example.com');
        if (token === VALID_JWT_B) throw makeFirebaseError('auth/invalid-id-token');
        return makeDecodedToken('user-c', 'c@example.com');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A, VALID_JWT_B, VALID_JWT_C] },
      });

      const body = JSON.parse(res.body);
      expect(body.results[0].index).toBe(0);
      expect(body.results[0].valid).toBe(true);
      expect(body.results[1].index).toBe(1);
      expect(body.results[1].valid).toBe(false);
      expect(body.results[2].index).toBe(2);
      expect(body.results[2].valid).toBe(true);
    });
  });

  // --- Error category mapping (ADR-002) ---

  describe('error category mapping (ADR-002)', () => {
    it('maps auth/id-token-expired to "expired"', async () => {
      mocks.verifyIdToken.mockRejectedValue(makeFirebaseError('auth/id-token-expired'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      const body = JSON.parse(res.body);
      expect(body.results[0].error).toBe('expired');
    });

    it('maps structurally invalid token to "malformed"', async () => {
      // Malformed token fails structure validation — SDK is not called
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [MALFORMED_TOKEN] },
      });

      const body = JSON.parse(res.body);
      expect(body.results[0].valid).toBe(false);
      expect(body.results[0].error).toBe('malformed');
      expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    });

    it('maps auth/invalid-id-token to "invalid"', async () => {
      mocks.verifyIdToken.mockRejectedValue(makeFirebaseError('auth/invalid-id-token'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      const body = JSON.parse(res.body);
      expect(body.results[0].error).toBe('invalid');
    });

    it('maps auth/id-token-revoked to "revoked"', async () => {
      mocks.verifyIdToken.mockRejectedValue(makeFirebaseError('auth/id-token-revoked'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      const body = JSON.parse(res.body);
      expect(body.results[0].error).toBe('revoked');
    });

    it('maps auth/argument-error to "invalid"', async () => {
      mocks.verifyIdToken.mockRejectedValue(makeFirebaseError('auth/argument-error'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      const body = JSON.parse(res.body);
      expect(body.results[0].error).toBe('invalid');
    });
  });

  // --- Summary counts ---

  describe('summary counts', () => {
    it('summary counts match results', async () => {
      mocks.verifyIdToken.mockImplementation(async (token: string) => {
        if (token === VALID_JWT_A) return makeDecodedToken('user-a', 'a@example.com');
        throw makeFirebaseError('auth/invalid-id-token');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A, VALID_JWT_B, MALFORMED_TOKEN] },
      });

      const body = JSON.parse(res.body);
      const validCount = body.results.filter((r: { valid: boolean }) => r.valid).length;
      const invalidCount = body.results.filter((r: { valid: boolean }) => !r.valid).length;
      expect(body.summary.total).toBe(3);
      expect(body.summary.valid).toBe(validCount);
      expect(body.summary.invalid).toBe(invalidCount);
      expect(body.summary.total).toBe(body.summary.valid + body.summary.invalid);
    });
  });

  // --- Input validation (400) ---

  describe('input validation (400 responses)', () => {
    it('returns 400 for more than 25 tokens', async () => {
      const tokens = Array.from({ length: 26 }, (_, i) =>
        `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLSR7aX0ifQ.${Buffer.from(`sig${i}`).toString('base64url')}`,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts exactly 25 tokens', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user', 'u@example.com'));
      const tokens = Array.from({ length: 25 }, (_, i) =>
        `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLSR7aX0ifQ.${Buffer.from(`sig${i}`).toString('base64url')}`,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 400 for empty array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for missing tokens field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for tokens as object (non-coercible to array)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: { not: 'an-array' } },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for tokens containing empty string', async () => {
      // Ajv coerces numbers to strings; empty string violates minLength: 1
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [''] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for missing request body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
      });

      expect(res.statusCode).toBe(400);
    });

    it('single token in array works', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toHaveLength(1);
      expect(body.summary.total).toBe(1);
    });
  });

  // --- check_revoked opt-in (T-045) ---

  describe('check_revoked opt-in', () => {
    it('defaults to passing checkRevoked=false when omitted', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));

      await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      expect(mocks.verifyIdToken).toHaveBeenCalledWith(VALID_JWT_A, false);
    });

    it('passes checkRevoked=true to all tokens when check_revoked is true', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));

      await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A, VALID_JWT_B], check_revoked: true },
      });

      expect(mocks.verifyIdToken).toHaveBeenCalledWith(VALID_JWT_A, true);
      expect(mocks.verifyIdToken).toHaveBeenCalledWith(VALID_JWT_B, true);
    });

    it('maps auth/id-token-revoked to "revoked" category', async () => {
      mocks.verifyIdToken.mockRejectedValue(makeFirebaseError('auth/id-token-revoked'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A], check_revoked: true },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results[0].valid).toBe(false);
      expect(body.results[0].error).toBe('revoked');
    });

    it('succeeds for non-revoked tokens with check_revoked=true', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A], check_revoked: true },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results[0].valid).toBe(true);
      expect(body.results[0].uid).toBe('user-a');
    });
  });

  // --- X-Request-ID ---

  describe('correlation ID', () => {
    it('returns X-Request-ID response header', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      expect(res.headers['x-request-id']).toBeDefined();
    });
  });

  // --- Concurrency cap ---

  describe('concurrency cap', () => {
    it('limits concurrent verifyIdToken calls to 5', async () => {
      let currentConcurrency = 0;
      let maxConcurrency = 0;

      mocks.verifyIdToken.mockImplementation(async (token: string) => {
        currentConcurrency++;
        if (currentConcurrency > maxConcurrency) {
          maxConcurrency = currentConcurrency;
        }
        // Small delay to allow concurrency to build
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrency--;
        return {
          uid: `user-${token.slice(-3)}`,
          email: 'u@example.com',
          email_verified: true,
          iat: 1708300000,
          exp: 1708303600,
          auth_time: 1708299700,
          iss: 'https://securetoken.google.com/test-project',
          sub: `user-${token.slice(-3)}`,
          aud: 'test-project',
          firebase: { sign_in_provider: 'google.com' },
        };
      });

      // Send 10 valid tokens
      const tokens = Array.from({ length: 10 }, (_, i) =>
        `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLSR7aX0ifQ.${Buffer.from(`sig${i}`).toString('base64url')}`,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.total).toBe(10);
      expect(body.summary.valid).toBe(10);
      expect(maxConcurrency).toBeLessThanOrEqual(5);
      expect(maxConcurrency).toBeGreaterThan(0);
    });
  });

  // --- Response schema conformance ---

  describe('response schema conformance', () => {
    it('valid result includes all required fields', async () => {
      mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      const body = JSON.parse(res.body);
      const result = body.results[0];
      expect(result).toHaveProperty('index');
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('uid');
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('token_metadata');
    });

    it('invalid result includes index, valid, and error', async () => {
      mocks.verifyIdToken.mockRejectedValue(makeFirebaseError('auth/id-token-expired'));

      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT_A] },
      });

      const body = JSON.parse(res.body);
      const result = body.results[0];
      expect(result).toHaveProperty('index');
      expect(result.valid).toBe(false);
      expect(result).toHaveProperty('error');
      expect(['expired', 'invalid', 'malformed', 'revoked']).toContain(result.error);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import verifyRoute, {
  MIN_RESPONSE_TIME_MS,
  normalizeResponseTime,
} from '../src/routes/verify.js';

// Fake firebase plugin per ADR-011 — decorates firebaseAuth with mock verifyIdToken
function createFakeFirebasePlugin(mockVerifyIdToken: ReturnType<typeof vi.fn>) {
  return fp(
    async (fastify: FastifyInstance) => {
      fastify.decorate('firebaseAuth', { verifyIdToken: mockVerifyIdToken });
    },
    { name: 'firebase' },
  );
}

// Valid JWT structure (3 base64url segments) — content doesn't matter, just structure
const VALID_JWT_STRUCTURE =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ';

const DECODED_TOKEN = {
  uid: 'test-uid-123',
  email: 'user@example.com',
  email_verified: true,
  name: 'Test User',
  picture: 'https://example.com/photo.jpg',
  iat: 1708300000,
  exp: 1708303600,
  auth_time: 1708299700,
  iss: 'https://securetoken.google.com/test-project',
  sub: 'test-uid-123',
  aud: 'test-project',
  firebase: { sign_in_provider: 'google.com' },
};

describe('normalizeResponseTime (unit)', () => {
  it('delays when elapsed time is less than MIN_RESPONSE_TIME_MS', async () => {
    const start = Date.now();
    await normalizeResponseTime(start);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(MIN_RESPONSE_TIME_MS * 0.8);
  });

  it('does not delay when elapsed time exceeds MIN_RESPONSE_TIME_MS', async () => {
    const start = Date.now() - MIN_RESPONSE_TIME_MS - 50; // simulate already elapsed
    const before = Date.now();
    await normalizeResponseTime(start);
    const after = Date.now();
    expect(after - before).toBeLessThan(20); // should return nearly immediately
  });
});

describe('verify route timing normalization (ADR-010)', () => {
  let app: FastifyInstance;
  let mockVerifyIdToken: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockVerifyIdToken = vi.fn();
    app = Fastify();
    await app.register(sensible);
    await app.register(createFakeFirebasePlugin(mockVerifyIdToken));
    await app.register(verifyRoute);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 with timing normalization when verifyIdToken rejects', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('auth/id-token-expired'));

    const start = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { token: VALID_JWT_STRUCTURE },
    });
    const elapsed = Date.now() - start;

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Unauthorized',
      statusCode: 401,
    });
    // Error response must be delayed to at least MIN_RESPONSE_TIME_MS (ADR-010)
    expect(elapsed).toBeGreaterThanOrEqual(MIN_RESPONSE_TIME_MS * 0.8);
  });

  it('returns 400 with timing normalization for invalid JWT structure', async () => {
    const start = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { token: 'not-a-jwt-at-all' },
    });
    const elapsed = Date.now() - start;

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Bad Request',
      statusCode: 400,
    });
    // Structural validation failure also normalized (ADR-010)
    expect(elapsed).toBeGreaterThanOrEqual(MIN_RESPONSE_TIME_MS * 0.8);
  });

  it('returns 200 without artificial delay on successful verification', async () => {
    mockVerifyIdToken.mockResolvedValue(DECODED_TOKEN);

    const start = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { token: VALID_JWT_STRUCTURE },
    });
    const elapsed = Date.now() - start;

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.uid).toBe('test-uid-123');
    expect(body.email).toBe('user@example.com');
    expect(body.token_metadata.sign_in_provider).toBe('google.com');
    // Success path should not be artificially delayed
    expect(elapsed).toBeLessThan(MIN_RESPONSE_TIME_MS);
  });

  it('returns correct response shape on success', async () => {
    mockVerifyIdToken.mockResolvedValue(DECODED_TOKEN);

    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { token: VALID_JWT_STRUCTURE },
    });

    const body = JSON.parse(response.body);
    expect(body).toEqual({
      uid: 'test-uid-123',
      email: 'user@example.com',
      email_verified: true,
      name: 'Test User',
      picture: 'https://example.com/photo.jpg',
      custom_claims: {},
      token_metadata: {
        iat: 1708300000,
        exp: 1708303600,
        auth_time: 1708299700,
        iss: 'https://securetoken.google.com/test-project',
        sign_in_provider: 'google.com',
      },
    });
  });

  it('returns 400 via schema validation for missing token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 via schema validation for empty token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { token: '' },
    });

    expect(response.statusCode).toBe(400);
  });
});

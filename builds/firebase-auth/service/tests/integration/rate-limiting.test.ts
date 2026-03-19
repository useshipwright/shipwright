import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_KEY_A = 'rl-integration-key-aaa';
const KEY_ID_A = createHash('sha256').update(TEST_KEY_A).digest('hex').slice(0, 8);
const TEST_KEY_B = 'rl-integration-key-bbb';
const KEY_ID_B = createHash('sha256').update(TEST_KEY_B).digest('hex').slice(0, 8);

const fakeApiKeys: ReadonlyMap<string, Buffer> = new Map([
  [KEY_ID_A, Buffer.from(TEST_KEY_A)],
  [KEY_ID_B, Buffer.from(TEST_KEY_B)],
]);

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted, but vi.doMock is used after resetModules
// ---------------------------------------------------------------------------

vi.mock('../../src/infra/config.js', () => ({
  config: { apiKeys: fakeApiKeys },
}));

vi.mock('../../src/plugins/metrics.js', () => ({
  incrementRateLimitExceeded: vi.fn(),
  default: {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'metrics',
    default: async () => {},
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildRateLimitApp(limits: {
  read?: number;
  mutation?: number;
  batch?: number;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  const { default: apiKeyAuth } = await import('../../src/plugins/api-key-auth.js');
  const { default: rateLimiter } = await import('../../src/plugins/rate-limiter.js');

  await app.register(requestContext);
  await app.register(apiKeyAuth);
  await app.register(rateLimiter, {
    config: {
      rateLimitRead: limits.read ?? 3,
      rateLimitMutation: limits.mutation ?? 2,
      rateLimitBatch: limits.batch ?? 1,
    },
  });

  // Test routes with different rate-limit classes
  app.get('/read-endpoint', { config: { rateLimitClasses: ['read'] } }, async () => ({ ok: true }));
  app.post('/mutation-endpoint', { config: { rateLimitClasses: ['mutation'] } }, async () => ({ ok: true }));
  app.post('/batch-endpoint', { config: { rateLimitClasses: ['batch'] } }, async () => ({ ok: true }));
  app.post('/dual-endpoint', { config: { rateLimitClasses: ['read', 'batch'] } }, async () => ({ ok: true }));

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rate limiting integration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Reset modules to clear rate-limiter bucket state
    vi.resetModules();
    vi.doMock('../../src/infra/config.js', () => ({
      config: { apiKeys: fakeApiKeys },
    }));
    vi.doMock('../../src/plugins/metrics.js', () => ({
      incrementRateLimitExceeded: vi.fn(),
      default: {
        [Symbol.for('skip-override')]: true,
        [Symbol.for('fastify.display-name')]: 'metrics',
        default: async () => {},
      },
    }));

    app = await buildRateLimitApp({ read: 3, mutation: 2, batch: 1 });
  });

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Read class rate limiting
  // -----------------------------------------------------------------------

  it('returns 429 with Retry-After when read limit is exceeded', async () => {
    const headers = { 'x-api-key': TEST_KEY_A };

    // Exhaust read limit (3)
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/read-endpoint', headers });
      expect(res.statusCode).toBe(200);
    }

    // Next request should be rate-limited
    const res = await app.inject({ method: 'GET', url: '/read-endpoint', headers });
    expect(res.statusCode).toBe(429);

    const body = res.json();
    expect(body.error.code).toBe(429);
    expect(body.error.message).toBe('Too many requests');

    // Retry-After header present and reasonable
    const retryAfter = parseInt(String(res.headers['retry-after']), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  // -----------------------------------------------------------------------
  // Mutation class rate limiting
  // -----------------------------------------------------------------------

  it('returns 429 when mutation limit is exceeded', async () => {
    const headers = { 'x-api-key': TEST_KEY_A };

    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'POST', url: '/mutation-endpoint', headers });
    }

    const res = await app.inject({ method: 'POST', url: '/mutation-endpoint', headers });
    expect(res.statusCode).toBe(429);
  });

  // -----------------------------------------------------------------------
  // Independent rate-limit classes
  // -----------------------------------------------------------------------

  it('tracks read and mutation classes independently', async () => {
    const headers = { 'x-api-key': TEST_KEY_A };

    // Exhaust read limit (3)
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/read-endpoint', headers });
    }

    // Read is exhausted
    const readRes = await app.inject({ method: 'GET', url: '/read-endpoint', headers });
    expect(readRes.statusCode).toBe(429);

    // Mutation should still work (separate class)
    const mutRes = await app.inject({ method: 'POST', url: '/mutation-endpoint', headers });
    expect(mutRes.statusCode).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Dual-class endpoint consumes from both buckets
  // -----------------------------------------------------------------------

  it('dual-class endpoint consumes from both buckets', async () => {
    const headers = { 'x-api-key': TEST_KEY_A };

    // batch limit = 1; one request to dual-class exhausts it
    const res1 = await app.inject({ method: 'POST', url: '/dual-endpoint', headers });
    expect(res1.statusCode).toBe(200);

    // Second dual-class request should be rejected (batch exhausted)
    const res2 = await app.inject({ method: 'POST', url: '/dual-endpoint', headers });
    expect(res2.statusCode).toBe(429);

    // Pure read should still work (dual consumed 1 of 3 read slots)
    const readRes = await app.inject({ method: 'GET', url: '/read-endpoint', headers });
    expect(readRes.statusCode).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Different API keys have independent limits
  // -----------------------------------------------------------------------

  it('different API keys have independent rate limits', async () => {
    const headersA = { 'x-api-key': TEST_KEY_A };
    const headersB = { 'x-api-key': TEST_KEY_B };

    // Exhaust read limit for key A
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/read-endpoint', headers: headersA });
    }
    const resA = await app.inject({ method: 'GET', url: '/read-endpoint', headers: headersA });
    expect(resA.statusCode).toBe(429);

    // Key B should still have capacity
    const resB = await app.inject({ method: 'GET', url: '/read-endpoint', headers: headersB });
    expect(resB.statusCode).toBe(200);
  });
});

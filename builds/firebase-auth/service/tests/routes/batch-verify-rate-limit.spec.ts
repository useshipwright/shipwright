import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildRouteTestApp, type MockFirebaseAuth } from '../helpers/build-test-app.js';
import verifyRoute from '../../src/routes/verify.js';

// Mock config to use a tight rate limit for tests (3 per second)
vi.mock('../../src/config.js', () => ({
  config: {
    port: 8080,
    nodeEnv: 'test',
    logLevel: 'silent',
    batchRateLimit: {
      max: 3,
      timeWindow: '1 second',
    },
  },
}));

// Import batch-verify AFTER vi.mock so the mock is applied
const { default: batchVerifyRoute } = await import('../../src/routes/batch-verify.js');

const VALID_JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEifQ.c2lnbmF0dXJlQQ';

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

describe('POST /batch-verify — rate limiting', () => {
  let app: FastifyInstance;
  let mocks: MockFirebaseAuth;

  beforeEach(async () => {
    const testApp = await buildRouteTestApp(batchVerifyRoute);
    app = testApp.app;
    mocks = testApp.mocks;
    mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows requests within rate limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT] },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('returns 429 when rate limit is exceeded', async () => {
    // Exhaust the rate limit (3 requests)
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT] },
      });
    }

    // 4th request should be rate limited
    const res = await app.inject({
      method: 'POST',
      url: '/batch-verify',
      payload: { tokens: [VALID_JWT] },
    });

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.statusCode).toBe(429);
    expect(body.error).toBe('Too Many Requests');
    expect(body.message).toMatch(/rate limit/i);
  });

  it('includes rate limit headers on successful responses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/batch-verify',
      payload: { tokens: [VALID_JWT] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('includes retry-after header on 429 response', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/batch-verify',
        payload: { tokens: [VALID_JWT] },
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/batch-verify',
      payload: { tokens: [VALID_JWT] },
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('x-ratelimit-remaining decrements with each request', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/batch-verify',
      payload: { tokens: [VALID_JWT] },
    });
    const remaining1 = parseInt(res1.headers['x-ratelimit-remaining'] as string, 10);

    const res2 = await app.inject({
      method: 'POST',
      url: '/batch-verify',
      payload: { tokens: [VALID_JWT] },
    });
    const remaining2 = parseInt(res2.headers['x-ratelimit-remaining'] as string, 10);

    expect(remaining2).toBe(remaining1 - 1);
  });
});

describe('rate limiting is NOT applied to non-batch routes', () => {
  let app: FastifyInstance;
  let mocks: MockFirebaseAuth;

  beforeEach(async () => {
    const testApp = await buildRouteTestApp(verifyRoute);
    app = testApp.app;
    mocks = testApp.mocks;
    mocks.verifyIdToken.mockResolvedValue(makeDecodedToken('user-a', 'a@example.com'));
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /verify is not rate limited', async () => {
    // Send more requests than the batch rate limit (3)
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/verify',
        payload: { token: VALID_JWT },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

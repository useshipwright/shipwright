import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_KEY_A = 'test-key-alpha-1234';
const TEST_KEY_B = 'test-key-beta-5678';

const KEY_ID_A = createHash('sha256').update(TEST_KEY_A).digest('hex').slice(0, 8);
const KEY_ID_B = createHash('sha256').update(TEST_KEY_B).digest('hex').slice(0, 8);

const fakeApiKeys: ReadonlyMap<string, Buffer> = new Map([
  [KEY_ID_A, Buffer.from(TEST_KEY_A)],
  [KEY_ID_B, Buffer.from(TEST_KEY_B)],
]);

// ---------------------------------------------------------------------------
// Mock the config module (api-key-auth imports config.apiKeys)
// ---------------------------------------------------------------------------

vi.mock('../../src/infra/config.js', () => ({
  config: {
    apiKeys: fakeApiKeys,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register the plugin under test
  const { default: apiKeyAuth } = await import('../../src/plugins/api-key-auth.js');
  await app.register(apiKeyAuth);

  // A simple protected route that returns the apiKeyId
  app.get('/protected', async (request) => ({
    apiKeyId: request.apiKeyId,
  }));

  // Health and metrics are skip-paths — register simple handlers for them
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/metrics', async () => 'metrics data');

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('api-key-auth plugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Successful authentication
  // -----------------------------------------------------------------------

  describe('successful authentication', () => {
    it('authenticates with a valid API key and decorates request.apiKeyId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': TEST_KEY_A },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().apiKeyId).toBe(KEY_ID_A);
    });

    it('authenticates with a second valid key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': TEST_KEY_B },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().apiKeyId).toBe(KEY_ID_B);
    });
  });

  // -----------------------------------------------------------------------
  // 401 on invalid / missing key
  // -----------------------------------------------------------------------

  describe('401 responses', () => {
    it('returns 401 when X-API-Key header is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe(401);
      expect(body.error.message).toBe('Unauthorized');
    });

    it('returns 401 when X-API-Key header is empty string', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': '' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when X-API-Key value is wrong', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': 'completely-wrong-key' },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.message).toBe('Unauthorized');
    });

    it('returns generic 401 message — no info leakage between missing and invalid', async () => {
      const missingRes = await app.inject({
        method: 'GET',
        url: '/protected',
      });

      const invalidRes = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': 'wrong' },
      });

      // Both should return the exact same error shape and message
      expect(missingRes.json().error.message).toBe(invalidRes.json().error.message);
    });
  });

  // -----------------------------------------------------------------------
  // Skip paths (/health, /metrics)
  // -----------------------------------------------------------------------

  describe('skip paths', () => {
    it('skips auth for /health — returns 200 without X-API-Key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
    });

    it('skips auth for /metrics — returns 200 without X-API-Key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(res.statusCode).toBe(200);
    });

    it('skips auth for /health with query string', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health?foo=bar',
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Timing-safe comparison coverage
  // -----------------------------------------------------------------------

  describe('timing-safe comparison', () => {
    it('rejects a key that is a substring of a valid key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': TEST_KEY_A.slice(0, 5) },
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects a key that is longer than any valid key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': TEST_KEY_A + 'extra-stuff' },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});

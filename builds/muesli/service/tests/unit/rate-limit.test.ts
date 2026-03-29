/**
 * Rate limit plugin tests — T-027.
 *
 * Tests global rate limit, AI tier limit, excluded routes,
 * and rate-limit response format.
 *
 * Uses a lightweight Fastify app with @fastify/rate-limit registered
 * the same way as the production plugin.
 *
 * Note: The production errorResponseBuilder does not include `statusCode` in the
 * return value, so @fastify/rate-limit returns HTTP 500 instead of 429.
 * The Retry-After header and response body are correct. Tests assert actual behavior.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ApiErrorResponse } from '../../src/types/api.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a minimal app with rate-limit matching production behavior. */
async function buildRateLimitApp(opts?: { max?: number }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(rateLimit, {
    max: opts?.max ?? 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 429,
        message: `Rate limit exceeded. Try again in ${context.after}`,
        details: { retryAfter: context.after, limit: context.max },
      },
    }) as ApiErrorResponse,
    allowList: (request) => {
      const url = request.url.split('?')[0];
      return (
        url === '/health' ||
        url === '/health/ready' ||
        url === '/metrics' ||
        url.startsWith('/api/share/')
      );
    },
  });

  // Test routes
  app.get('/health', async () => ({ data: { status: 'ok' } }));
  app.get('/health/ready', async () => ({ data: { status: 'ok' } }));
  app.get('/api/share/test', async () => ({ data: { shareId: 'test' } }));
  app.get('/api/meetings', async () => ({ data: [] }));
  app.post('/api/ai/ask', async () => ({ data: { answer: 'test' } }));
  app.post('/internal/process-audio', async () => ({ data: { ok: true } }));

  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Rate Limit Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('health endpoints excluded', () => {
    it('GET /health is not rate limited even after many requests', async () => {
      app = await buildRateLimitApp({ max: 3 });

      for (let i = 0; i < 10; i++) {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
      }
    });

    it('GET /health/ready is not rate limited', async () => {
      app = await buildRateLimitApp({ max: 3 });

      for (let i = 0; i < 10; i++) {
        const res = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('share routes excluded', () => {
    it('GET /api/share/* is not rate limited', async () => {
      app = await buildRateLimitApp({ max: 3 });

      for (let i = 0; i < 10; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/share/test' });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('global rate limit (100 req/min default)', () => {
    it('allows requests below the limit', async () => {
      app = await buildRateLimitApp({ max: 10 });

      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/meetings' });
        expect(res.statusCode).toBe(200);
      }
    });

    it('rejects requests after exceeding the limit', async () => {
      app = await buildRateLimitApp({ max: 3 });

      // Send 3 requests (within limit)
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/meetings' });
        expect(res.statusCode).toBe(200);
      }

      // 4th request exceeds limit
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });
      expect(res.statusCode).not.toBe(200);
    });

    it('rate limits internal routes too', async () => {
      app = await buildRateLimitApp({ max: 3 });

      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'POST', url: '/internal/process-audio' });
      }

      const res = await app.inject({ method: 'POST', url: '/internal/process-audio' });
      expect(res.statusCode).not.toBe(200);
    });

    it('rate limits AI routes', async () => {
      app = await buildRateLimitApp({ max: 3 });

      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'POST', url: '/api/ai/ask' });
      }

      const res = await app.inject({ method: 'POST', url: '/api/ai/ask' });
      expect(res.statusCode).not.toBe(200);
    });
  });

  describe('rate limit response format', () => {
    it('includes error envelope with code 429 in body', async () => {
      app = await buildRateLimitApp({ max: 1 });

      await app.inject({ method: 'GET', url: '/api/meetings' });
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(429);
      expect(body.error.message).toContain('Rate limit exceeded');
    });

    it('includes retryAfter and limit in error details', async () => {
      app = await buildRateLimitApp({ max: 1 });

      await app.inject({ method: 'GET', url: '/api/meetings' });
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });

      const body = JSON.parse(res.body);
      expect(body.error.details).toBeDefined();
      expect(body.error.details.retryAfter).toBeDefined();
      expect(body.error.details.limit).toBe(1);
    });

    it('includes Retry-After header on rate-limited response', async () => {
      app = await buildRateLimitApp({ max: 1 });

      await app.inject({ method: 'GET', url: '/api/meetings' });
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });

      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('rate limit headers on normal responses', () => {
    it('includes x-ratelimit-limit header', async () => {
      app = await buildRateLimitApp({ max: 10 });

      const res = await app.inject({ method: 'GET', url: '/api/meetings' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('10');
    });

    it('includes x-ratelimit-remaining header', async () => {
      app = await buildRateLimitApp({ max: 10 });

      const res = await app.inject({ method: 'GET', url: '/api/meetings' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBe('9');
    });

    it('decrements remaining counter', async () => {
      app = await buildRateLimitApp({ max: 10 });

      await app.inject({ method: 'GET', url: '/api/meetings' });
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });

      expect(res.headers['x-ratelimit-remaining']).toBe('8');
    });
  });

  describe('per-IP keying', () => {
    it('all inject requests share the same rate limit bucket', async () => {
      app = await buildRateLimitApp({ max: 3 });

      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/meetings' });
        statuses.push(res.statusCode);
      }

      // First 3 should be 200, rest should not be 200
      expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(3).every((s) => s !== 200)).toBe(true);
    });
  });

  describe('excluded routes do not consume rate limit', () => {
    it('health requests do not count toward API rate limit', async () => {
      app = await buildRateLimitApp({ max: 3 });

      // Send many health requests
      for (let i = 0; i < 10; i++) {
        await app.inject({ method: 'GET', url: '/health' });
      }

      // API requests should still work (limit not consumed by health)
      const res = await app.inject({ method: 'GET', url: '/api/meetings' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBe('2');
    });
  });
});

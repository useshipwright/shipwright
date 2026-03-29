import { type FastifyInstance, type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import type { ApiErrorResponse } from '../types/api.js';

// ── Constants ───────────────────────────────────────────────────────

const GLOBAL_MAX = config.rateLimitMax; // 100 req/min default
const GLOBAL_WINDOW = config.rateLimitWindow; // '1 minute' default
const AI_MAX = 10;
const AI_WINDOW = '1 minute';

/** Routes that bypass rate limiting entirely. */
function isExcluded(url: string): boolean {
  return (
    url === '/health' ||
    url === '/health/ready' ||
    url === '/metrics' ||
    url.startsWith('/api/share/')
  );
}

/** Routes subject to the stricter AI rate limit. */
function isAiRoute(url: string): boolean {
  return (
    url.startsWith('/api/ai/') ||
    /^\/api\/meetings\/[^/]+\/notes\/generate/.test(url)
  );
}

/** Extract userId from an authenticated request for per-user keying. */
function keyGenerator(request: FastifyRequest): string {
  // After auth middleware runs, userId is set on the request.
  // Fall back to IP for unauthenticated paths (should not normally hit rate limit).
  return request.userId || request.ip;
}

/** Standard 429 error envelope matching the project's ApiErrorResponse shape. */
function errorResponseBuilder(
  _request: FastifyRequest,
  context: { max: number; after: string },
): ApiErrorResponse {
  return {
    error: {
      code: 429,
      message: `Rate limit exceeded. Try again in ${context.after}`,
      details: { retryAfter: context.after, limit: context.max },
    },
  };
}

// ── Plugin ──────────────────────────────────────────────────────────

async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  // Register the global tier — applies to all /api/* routes
  await app.register(rateLimit, {
    max: GLOBAL_MAX,
    timeWindow: GLOBAL_WINDOW,
    keyGenerator,
    errorResponseBuilder,
    allowList: (request: FastifyRequest) => {
      const url = request.url.split('?')[0];
      return isExcluded(url);
    },
  });

  // Register the stricter AI tier as a child plugin with its own store
  await app.register(
    async function aiRateLimitScope(child) {
      await child.register(rateLimit, {
        max: AI_MAX,
        timeWindow: AI_WINDOW,
        keyGenerator,
        errorResponseBuilder,
        allowList: (request: FastifyRequest) => {
          const url = request.url.split('?')[0];
          return !isAiRoute(url);
        },
      });
    },
  );
}

export default fp(rateLimitPlugin, {
  name: 'rate-limit',
  dependencies: ['auth'],
});

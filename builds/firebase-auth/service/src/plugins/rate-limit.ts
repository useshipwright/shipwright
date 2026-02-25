/**
 * Rate limiting plugin — mitigates Batch Endpoint Abuse (threat model).
 *
 * Registers @fastify/rate-limit with global: false so rate limiting is
 * only applied to routes that explicitly opt in via config.rateLimit.
 * The batch-verify route uses this to cap requests per caller.
 *
 * Uses in-memory LRU store (suitable for single-instance Cloud Run).
 * For multi-instance deployments, swap to a Redis store.
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';

async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: false,
  });
}

export default fp(rateLimitPlugin, {
  name: 'rate-limit',
});

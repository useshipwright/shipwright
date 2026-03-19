import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import type { RateLimitClass } from '../domain/types.js';
import { type AppConfig } from '../infra/config.js';
import { incrementRateLimitExceeded } from './metrics.js';

// ---------------------------------------------------------------------------
// Sliding-window counter — ADR-002
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000; // 1 minute

interface Bucket {
  prevCount: number;
  currentCount: number;
  windowStart: number; // ms timestamp of current window start
}

/** Module-scoped state — per-instance, in-memory (ADR-002). */
const buckets = new Map<string, Bucket>();

function compositeKey(apiKeyId: string, cls: RateLimitClass): string {
  return `${apiKeyId}:${cls}`;
}

function getLimitForClass(cfg: AppConfig, cls: RateLimitClass): number {
  switch (cls) {
    case 'read':
      return cfg.rateLimitRead;
    case 'mutation':
      return cfg.rateLimitMutation;
    case 'batch':
      return cfg.rateLimitBatch;
  }
}

/**
 * Get or create a bucket, advancing the window if needed.
 */
function getBucket(key: string, now: number): Bucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { prevCount: 0, currentCount: 0, windowStart: now };
    buckets.set(key, bucket);
    return bucket;
  }

  const elapsed = now - bucket.windowStart;
  if (elapsed >= WINDOW_MS * 2) {
    // Both windows have passed — full reset
    bucket.prevCount = 0;
    bucket.currentCount = 0;
    bucket.windowStart = now;
  } else if (elapsed >= WINDOW_MS) {
    // Current window has passed — rotate
    bucket.prevCount = bucket.currentCount;
    bucket.currentCount = 0;
    bucket.windowStart += WINDOW_MS;
  }

  return bucket;
}

/**
 * Weighted count across previous and current windows (sliding window approximation).
 */
function effectiveCount(bucket: Bucket, now: number): number {
  const elapsed = now - bucket.windowStart;
  const weight = Math.max(0, (WINDOW_MS - elapsed) / WINDOW_MS);
  return bucket.prevCount * weight + bucket.currentCount;
}

/**
 * Seconds until the current window rotates, which reduces effective count.
 */
function retryAfterSeconds(bucket: Bucket, now: number): number {
  const remaining = WINDOW_MS - (now - bucket.windowStart);
  return Math.max(1, Math.ceil(remaining / 1000));
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  config: AppConfig;
}

// ---------------------------------------------------------------------------
// Fastify plugin — preHandler hook (ADR-005 step 5)
// ---------------------------------------------------------------------------

async function rateLimiterPlugin(
  app: FastifyInstance,
  opts: RateLimiterOptions,
): Promise<void> {
  const cfg = opts.config;

  app.addHook(
    'preHandler',
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      // Skip requests without an authenticated API key (health, metrics)
      if (!request.apiKeyId) {
        done();
        return;
      }

      const classes = request.routeOptions.config.rateLimitClasses;
      if (!classes || classes.length === 0) {
        done();
        return;
      }

      const now = Date.now();

      // Phase 1: check all applicable buckets — reject if any would exceed
      for (const cls of classes) {
        const key = compositeKey(request.apiKeyId, cls);
        const bucket = getBucket(key, now);
        const limit = getLimitForClass(cfg, cls);

        if (effectiveCount(bucket, now) >= limit) {
          // Increment Prometheus counter
          incrementRateLimitExceeded(cls);

          request.log.warn(
            { apiKeyId: request.apiKeyId, rateLimitClass: cls, limit },
            'Rate limit exceeded',
          );

          void reply
            .status(429)
            .header('Retry-After', String(retryAfterSeconds(bucket, now)))
            .send({
              error: {
                code: 429,
                message: 'Too many requests',
                requestId:
                  (request as { requestId?: string }).requestId ?? '',
              },
            });
          return;
        }
      }

      // Phase 2: all buckets have capacity — consume from all applicable buckets
      for (const cls of classes) {
        const key = compositeKey(request.apiKeyId, cls);
        const bucket = getBucket(key, now);
        bucket.currentCount++;
      }

      done();
    },
  );
}

export default fp(rateLimiterPlugin, {
  name: 'rate-limiter',
  dependencies: ['api-key-auth'],
});

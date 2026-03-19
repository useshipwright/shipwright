import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../infra/config.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string;
  }
}

/** Paths that bypass API key authentication. */
const SKIP_PATHS = new Set(['/health', '/metrics']);

/**
 * API key authentication plugin — onRequest hook (ADR-005 step 4).
 *
 * - Skips /health and /metrics (unauthenticated per RBAC matrix).
 * - Reads X-API-Key header.
 * - Compares against ALL configured keys using crypto.timingSafeEqual
 *   without early exit to prevent timing attacks.
 * - On match, decorates request.apiKeyId with the sha256(key).slice(0,8) ID.
 * - On failure, returns 401 with a generic message — never distinguishes
 *   between missing and invalid key.
 * - Never logs API key values.
 */
async function apiKeyAuthPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('apiKeyId', '');

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    // Skip unauthenticated endpoints
    if (SKIP_PATHS.has(request.url.split('?')[0]!)) {
      done();
      return;
    }

    const headerValue = request.headers['x-api-key'];
    const supplied = typeof headerValue === 'string' && headerValue.length > 0
      ? headerValue
      : null;

    if (supplied === null) {
      void reply.status(401).send({
        error: {
          code: 401,
          message: 'Unauthorized',
          requestId: (request as { requestId?: string }).requestId ?? '',
        },
      });
      return;
    }

    const suppliedBuf = Buffer.from(supplied);
    let matchedKeyId: string | null = null;

    // Iterate ALL keys — no early exit on first mismatch (timing attack mitigation).
    for (const [keyId, keyBuf] of config.apiKeys) {
      // Normalize lengths for timingSafeEqual (requires equal-length buffers).
      // Use the configured key length as the target; pad or truncate the supplied
      // buffer to match so timingSafeEqual can be called safely.
      const targetLen = keyBuf.length;
      const normalised = new Uint8Array(targetLen);
      normalised.set(
        suppliedBuf.length >= targetLen
          ? suppliedBuf.subarray(0, targetLen)
          : suppliedBuf,
      );

      // Constant-time comparison. A length mismatch means the keys
      // definitely don't match, but we still perform the comparison
      // against all entries to avoid leaking which key slot was tried.
      const equal = timingSafeEqual(normalised, new Uint8Array(keyBuf)) &&
        suppliedBuf.length === targetLen;

      if (equal) {
        matchedKeyId = keyId;
      }
      // Do NOT break — continue iterating all remaining keys.
    }

    if (matchedKeyId !== null) {
      request.apiKeyId = matchedKeyId;
      request.log.debug({ apiKeyId: matchedKeyId }, 'API key authenticated');
      done();
    } else {
      request.log.warn('API key authentication failed');
      void reply.status(401).send({
        error: {
          code: 401,
          message: 'Unauthorized',
          requestId: (request as { requestId?: string }).requestId ?? '',
        },
      });
    }
  });
}

export default fp(apiKeyAuthPlugin, { name: 'api-key-auth' });

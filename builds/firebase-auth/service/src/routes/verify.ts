/**
 * POST /verify — single token verification (REQ-008, ADR-010).
 *
 * Validates JWT structure via validate-jwt, calls firebaseAuth.verifyIdToken(),
 * returns claims on success or generic 401 on any failure.
 *
 * Supports opt-in check_revoked parameter (default: false). When true,
 * verifyIdToken() makes an additional backend call to check if the token
 * has been revoked. v1 defaults to false per threat model (Token Replay
 * Attack — documented limitation).
 *
 * Timing normalization (ADR-010): enforces a minimum response time so that
 * fast-failing requests do not return faster than valid verifications,
 * mitigating timing side-channel attacks.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { isValidJwtStructure } from '../lib/validate-jwt.js';
import { redactUid } from '../lib/redact.js';
import { verifySchema } from '../schemas/verify.schema.js';
import type { VerifyRequest, VerifyResponse } from '../types/index.js';

/**
 * Minimum response time in milliseconds for error responses.
 * Prevents timing oracle attacks by ensuring error paths do not return
 * faster than successful verification (ADR-010).
 */
export const MIN_RESPONSE_TIME_MS = 100;

async function verifyRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: VerifyRequest }>(
    '/verify',
    { schema: verifySchema },
    async (request: FastifyRequest<{ Body: VerifyRequest }>, reply: FastifyReply) => {
      const startTime = Date.now();
      const { token, check_revoked: checkRevoked = false } = request.body;

      // JWT structure pre-validation (REQ-009)
      if (!isValidJwtStructure(token)) {
        request.log.warn('Token failed JWT structure validation');
        await normalizeResponseTime(startTime);
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400 });
      }

      try {
        // checkRevoked defaults to false (v1 limitation — threat model: Token Replay Attack).
        // Callers may opt in by setting check_revoked: true for sensitive operations.
        const decoded = await app.firebaseAuth.verifyIdToken(token, checkRevoked);

        // Extract custom claims — everything not in the standard Firebase token fields
        const standardFields = new Set([
          'aud',
          'auth_time',
          'exp',
          'firebase',
          'iat',
          'iss',
          'sub',
          'uid',
          'user_id',
          'email',
          'email_verified',
          'name',
          'picture',
        ]);
        const customClaims: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(decoded)) {
          if (!standardFields.has(key)) {
            customClaims[key] = value;
          }
        }

        const response: VerifyResponse = {
          uid: decoded.uid,
          email: decoded.email ?? null,
          email_verified: decoded.email_verified ?? null,
          name: (decoded as Record<string, unknown>).name as string ?? null,
          picture: decoded.picture ?? null,
          custom_claims: customClaims,
          token_metadata: {
            iat: decoded.iat,
            exp: decoded.exp,
            auth_time: decoded.auth_time,
            iss: decoded.iss,
            sign_in_provider: decoded.firebase?.sign_in_provider ?? 'unknown',
          },
        };

        const latencyMs = Date.now() - startTime;
        request.log.info(
          { uid: redactUid(decoded.uid), latencyMs },
          'Token verified successfully',
        );

        return reply.code(200).send(response);
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        // Log detailed error server-side only (REQ-008)
        request.log.warn(
          { err, latencyMs },
          'Token verification failed',
        );

        // Normalize timing — error responses must not return faster than successes (ADR-010)
        await normalizeResponseTime(startTime);

        return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
      }
    },
  );
}

/**
 * Ensures the response takes at least MIN_RESPONSE_TIME_MS from startTime.
 * Prevents timing oracle attacks by normalizing error response timing (ADR-010).
 */
export async function normalizeResponseTime(startTime: number): Promise<void> {
  const elapsed = Date.now() - startTime;
  const remaining = MIN_RESPONSE_TIME_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export default fp(verifyRoute, {
  name: 'verify-route',
  dependencies: ['firebase', '@fastify/sensible'],
});

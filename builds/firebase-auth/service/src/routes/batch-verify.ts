/**
 * POST /batch-verify — batch token verification (REQ-002, ADR-002).
 *
 * Accepts up to 25 tokens, validates each structure, verifies concurrently
 * via Promise.allSettled, returns per-token results with coarse error
 * categories per ADR-002 (expired, invalid, malformed).
 *
 * Supports opt-in check_revoked parameter (default: false). When true,
 * each verifyIdToken() call checks revocation status against the Firebase
 * Auth backend. v1 defaults to false per threat model.
 *
 * The batch itself always returns 200 if the request is well-formed;
 * individual token failures are reported per-result, not as HTTP errors.
 *
 * Max 25 tokens enforced to mitigate Batch Endpoint Abuse threat.
 * Rate limiting applied via @fastify/rate-limit to cap requests per caller.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import pLimit from 'p-limit';
import { isValidJwtStructure } from '../lib/validate-jwt.js';
import { batchVerifySchema } from '../schemas/batch-verify.schema.js';
import { config } from '../config.js';
import type {
  BatchVerifyRequest,
  BatchVerifyResponse,
  BatchTokenResult,
  BatchTokenResultValid,
  BatchTokenResultInvalid,
  BatchTokenError,
} from '../types/index.js';

/**
 * Maps Firebase error codes to coarse error categories per ADR-002.
 * - expired: auth/id-token-expired
 * - revoked: auth/id-token-revoked (only when check_revoked=true)
 * - malformed: structural validation failure (handled before SDK call)
 * - invalid: everything else
 */
function classifyError(err: unknown): BatchTokenError {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code === 'auth/id-token-expired') {
      return 'expired';
    }
    if (code === 'auth/id-token-revoked') {
      return 'revoked';
    }
  }
  return 'invalid';
}

async function batchVerifyRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: BatchVerifyRequest }>(
    '/batch-verify',
    {
      schema: batchVerifySchema,
      config: {
        rateLimit: {
          max: config.batchRateLimit.max,
          timeWindow: config.batchRateLimit.timeWindow,
        },
      },
    },
    async (request: FastifyRequest<{ Body: BatchVerifyRequest }>, reply: FastifyReply) => {
      const { tokens, check_revoked: checkRevoked = false } = request.body;

      // Standard Firebase token fields to exclude from custom_claims
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

      // Phase 1: Structure validation — classify malformed tokens immediately
      const verificationTasks: Array<{
        index: number;
        token: string;
        structureValid: boolean;
      }> = tokens.map((token, index) => ({
        index,
        token,
        structureValid: isValidJwtStructure(token),
      }));

      // Phase 2: Verify valid-structure tokens concurrently via Promise.allSettled
      // Cap at 5 concurrent Firebase SDK calls to prevent connection exhaustion
      const limit = pLimit(5);
      const validStructureTokens = verificationTasks.filter((t) => t.structureValid);
      const settledResults = await Promise.allSettled(
        validStructureTokens.map((t) => limit(() => app.firebaseAuth.verifyIdToken(t.token, checkRevoked))),
      );

      // Build a map of SDK results keyed by index
      const sdkResultMap = new Map<number, PromiseSettledResult<Awaited<ReturnType<typeof app.firebaseAuth.verifyIdToken>>>>();
      for (let i = 0; i < validStructureTokens.length; i++) {
        sdkResultMap.set(validStructureTokens[i].index, settledResults[i]);
      }

      // Phase 3: Assemble per-token results preserving input order
      let validCount = 0;
      let invalidCount = 0;

      const results: BatchTokenResult[] = verificationTasks.map((task) => {
        // Malformed — failed structure validation
        if (!task.structureValid) {
          invalidCount++;
          return {
            index: task.index,
            valid: false,
            error: 'malformed',
          } satisfies BatchTokenResultInvalid;
        }

        const settled = sdkResultMap.get(task.index)!;

        if (settled.status === 'fulfilled') {
          const decoded = settled.value;

          // Extract custom claims
          const customClaims: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(decoded)) {
            if (!standardFields.has(key)) {
              customClaims[key] = value;
            }
          }

          validCount++;
          return {
            index: task.index,
            valid: true,
            uid: decoded.uid,
            email: decoded.email ?? null,
            email_verified: decoded.email_verified ?? false,
            custom_claims: customClaims,
            token_metadata: {
              iat: decoded.iat,
              exp: decoded.exp,
              auth_time: decoded.auth_time,
              iss: decoded.iss,
              sign_in_provider: decoded.firebase?.sign_in_provider ?? 'unknown',
            },
          } satisfies BatchTokenResultValid;
        }

        // SDK verification failed — classify the error
        invalidCount++;
        return {
          index: task.index,
          valid: false,
          error: classifyError(settled.reason),
        } satisfies BatchTokenResultInvalid;
      });

      const response: BatchVerifyResponse = {
        results,
        summary: {
          total: tokens.length,
          valid: validCount,
          invalid: invalidCount,
        },
      };

      // Log batch summary
      request.log.info(
        { total: tokens.length, valid: validCount, invalid: invalidCount },
        'Batch verification completed',
      );

      return reply.code(200).send(response);
    },
  );
}

export default fp(batchVerifyRoute, {
  name: 'batch-verify-route',
  dependencies: ['firebase', '@fastify/sensible', 'rate-limit'],
});

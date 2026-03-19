import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirebaseAdapter } from '../domain/types.js';
import { validateJwtStructure, validateBatchSize } from '../domain/validators.js';

export interface VerifyRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const BATCH_VERIFY_MAX = 25;

const verifyRoutes: FastifyPluginAsync<VerifyRouteOptions> = async (
  app: FastifyInstance,
  opts: VerifyRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // -------------------------------------------------------------------------
  // POST /verify — single token verification
  // -------------------------------------------------------------------------

  app.post<{
    Body: { token: string; checkRevoked?: boolean };
  }>('/verify', {
    config: { rateLimitClasses: ['read'] },
  }, async (request, reply) => {
    const { token, checkRevoked = false } = request.body ?? {};

    if (!token || typeof token !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: token',
          requestId: request.requestId ?? '',
        },
      });
    }

    const validation = validateJwtStructure(token);
    if (!validation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: validation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    // Delegate to Firebase SDK — errors (expired, revoked, invalid signature)
    // propagate to the error handler plugin which maps them to 401.
    const decoded = await firebaseAdapter.verifyIdToken(token, checkRevoked);

    return reply.status(200).send(decoded);
  });

  // -------------------------------------------------------------------------
  // POST /batch-verify — verify up to 25 tokens
  // -------------------------------------------------------------------------

  app.post<{
    Body: { tokens: { token: string; checkRevoked?: boolean }[] };
  }>('/batch-verify', {
    config: { rateLimitClasses: ['read', 'batch'] },
  }, async (request, reply) => {
    const { tokens } = request.body ?? {};

    if (!Array.isArray(tokens)) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: tokens',
          requestId: request.requestId ?? '',
        },
      });
    }

    const batchValidation = validateBatchSize(tokens, BATCH_VERIFY_MAX);
    if (!batchValidation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: batchValidation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    let validCount = 0;
    let invalidCount = 0;

    const results = await Promise.all(
      tokens.map(async (entry) => {
        const { token, checkRevoked = false } = entry ?? {};

        // Validate JWT structure before calling Firebase SDK
        if (!token || typeof token !== 'string') {
          invalidCount++;
          return { valid: false, error: 'Missing required field: token' };
        }

        const jwtValidation = validateJwtStructure(token);
        if (!jwtValidation.valid) {
          invalidCount++;
          return { valid: false, error: jwtValidation.error! };
        }

        try {
          const decoded = await firebaseAdapter.verifyIdToken(token, checkRevoked);
          validCount++;
          return {
            valid: true,
            uid: decoded.uid,
            email: decoded.email,
            claims: decoded.claims,
          };
        } catch (err: unknown) {
          invalidCount++;
          const message =
            err instanceof Error ? err.message : 'Token verification failed';
          return { valid: false, error: message };
        }
      }),
    );

    return reply.status(200).send({
      results,
      summary: {
        total: tokens.length,
        valid: validCount,
        invalid: invalidCount,
      },
    });
  });
};

export default verifyRoutes;

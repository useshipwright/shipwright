import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirebaseAdapter } from '../domain/types.js';
import {
  validateUid,
  validateClaimsSize,
  validateReservedClaims,
} from '../domain/validators.js';

export interface TokenRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const tokenRoutes: FastifyPluginAsync<TokenRouteOptions> = async (
  app: FastifyInstance,
  opts: TokenRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // ---------------------------------------------------------------------------
  // POST /tokens/custom — mint a custom token
  // ---------------------------------------------------------------------------

  app.post<{
    Body: { uid: string; claims?: Record<string, unknown> };
  }>('/tokens/custom', {
    config: { rateLimitClasses: ['mutation'] },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { uid, claims } = body as { uid?: string; claims?: Record<string, unknown> };

    if (!uid || typeof uid !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: uid',
          requestId: request.requestId ?? '',
        },
      });
    }

    const uidValidation = validateUid(uid);
    if (!uidValidation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: uidValidation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    if (claims !== undefined) {
      if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: 'claims must be a non-null object',
            requestId: request.requestId ?? '',
          },
        });
      }

      const reservedValidation = validateReservedClaims(claims);
      if (!reservedValidation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: reservedValidation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }

      const sizeValidation = validateClaimsSize(claims);
      if (!sizeValidation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: sizeValidation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }
    }

    const customToken = await firebaseAdapter.createCustomToken(uid, claims);

    return reply.status(200).send({ customToken, uid });
  });

  // ---------------------------------------------------------------------------
  // POST /users/:uid/revoke — revoke all refresh tokens
  // ---------------------------------------------------------------------------

  app.post<{
    Params: { uid: string };
  }>('/users/:uid/revoke', {
    config: { rateLimitClasses: ['mutation'] },
  }, async (request, reply) => {
    const { uid } = request.params;

    const uidValidation = validateUid(uid);
    if (!uidValidation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: uidValidation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    // Revoke tokens — Firebase SDK errors (auth/user-not-found → 404) handled by error-handler
    await firebaseAdapter.revokeRefreshTokens(uid);

    // Fetch updated user to get tokensValidAfterTime
    const user = await firebaseAdapter.getUser(uid);

    app.emitAudit(request, {
      event: 'tokens.revoked',
      target: uid,
      changes: { fields: ['refreshTokens'] },
    });

    return reply.status(200).send({
      tokensValidAfterTime: user.tokensValidAfterTime,
    });
  });
};

export default tokenRoutes;

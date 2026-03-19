import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirebaseAdapter } from '../domain/types.js';
import {
  validateUid,
  validateClaimsSize,
  validateReservedClaims,
} from '../domain/validators.js';

export interface ClaimsRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const claimsRoutes: FastifyPluginAsync<ClaimsRouteOptions> = async (
  app: FastifyInstance,
  opts: ClaimsRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // ---------------------------------------------------------------------------
  // PUT /users/:uid/claims — set custom claims (replaces all existing)
  // ---------------------------------------------------------------------------

  app.put<{ Params: { uid: string }; Body: Record<string, unknown> }>(
    '/users/:uid/claims',
    { config: { rateLimitClasses: ['mutation'] } },
    async (request, reply) => {
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

      const body = (request.body ?? {}) as Record<string, unknown>;
      const claims = body.claims;

      if (claims === undefined || claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: 'claims must be a non-null object',
            requestId: request.requestId ?? '',
          },
        });
      }

      const claimsObj = claims as Record<string, unknown>;

      // Validate reserved claim names before SDK call
      const reservedValidation = validateReservedClaims(claimsObj);
      if (!reservedValidation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: reservedValidation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }

      // Validate claims size — 1000 characters per ADR-009/ADR-010
      const sizeValidation = validateClaimsSize(claimsObj);
      if (!sizeValidation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: sizeValidation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }

      // Firebase SDK errors (auth/user-not-found → 404) handled by error-handler plugin
      await firebaseAdapter.setCustomUserClaims(uid, claimsObj);

      app.emitAudit(request, {
        event: 'claims.set',
        target: uid,
        changes: { fields: Object.keys(claimsObj) },
      });

      return reply.status(200).send({ claims: claimsObj });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /users/:uid/claims — remove all custom claims
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { uid: string } }>(
    '/users/:uid/claims',
    { config: { rateLimitClasses: ['mutation'] } },
    async (request, reply) => {
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

      // Use null to clear claims per PRD validation / prd_validation.md
      await firebaseAdapter.setCustomUserClaims(uid, null);

      app.emitAudit(request, {
        event: 'claims.deleted',
        target: uid,
        changes: { fields: [] },
      });

      return reply.status(204).send();
    },
  );
};

export default claimsRoutes;

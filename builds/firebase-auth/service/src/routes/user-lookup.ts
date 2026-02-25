/**
 * GET /user-lookup/:uid — user profile lookup.
 *
 * Validates UID format (non-empty, max 128 chars, alphanumeric/hyphens/underscores)
 * to mitigate SSRF via User-Lookup UID threat. Calls firebaseAuth.getUser(uid).
 * Explicitly allowlists response fields to prevent passwordHash/passwordSalt exposure
 * (threat model mitigation). Returns 404 for unknown UID, 400 for malformed UID.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { redactUid } from '../lib/redact.js';
import { userLookupSchema } from '../schemas/user-lookup.schema.js';
import type { UserLookupResponse } from '../types/index.js';

async function userLookupRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uid: string } }>(
    '/user-lookup/:uid',
    { schema: userLookupSchema },
    async (request: FastifyRequest<{ Params: { uid: string } }>, reply: FastifyReply) => {
      const { uid } = request.params;

      try {
        const userRecord = await app.firebaseAuth.getUser(uid);

        // Explicitly allowlist fields — MUST NOT include passwordHash or passwordSalt
        const response: UserLookupResponse = {
          uid: userRecord.uid,
          email: userRecord.email ?? null,
          email_verified: userRecord.emailVerified,
          display_name: userRecord.displayName ?? null,
          photo_url: userRecord.photoURL ?? null,
          phone_number: userRecord.phoneNumber ?? null,
          disabled: userRecord.disabled,
          custom_claims: userRecord.customClaims ?? null,
          provider_data: (userRecord.providerData ?? []).map((p) => ({
            provider_id: p.providerId,
            uid: p.uid,
            email: p.email ?? null,
            display_name: p.displayName ?? null,
            photo_url: p.photoURL ?? null,
          })),
          metadata: {
            creation_time: userRecord.metadata.creationTime,
            last_sign_in_time: userRecord.metadata.lastSignInTime,
            last_refresh_time: userRecord.metadata.lastRefreshTime ?? null,
          },
        };

        request.log.info(
          { uid: redactUid(uid) },
          'User lookup successful',
        );

        return reply.code(200).send(response);
      } catch (err) {
        // auth/user-not-found → 404
        if (err && typeof err === 'object' && 'code' in err) {
          const code = (err as { code: string }).code;
          if (code === 'auth/user-not-found') {
            request.log.info(
              { uid: redactUid(uid) },
              'User not found',
            );
            return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
          }
        }

        // All other errors → 500 with generic message
        request.log.error(
          { err, uid: redactUid(uid) },
          'User lookup failed',
        );
        return reply.code(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }
    },
  );
}

export default fp(userLookupRoute, {
  name: 'user-lookup-route',
  dependencies: ['firebase', '@fastify/sensible'],
});

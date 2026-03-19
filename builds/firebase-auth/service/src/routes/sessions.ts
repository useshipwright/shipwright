import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirebaseAdapter } from '../domain/types.js';
import { validateSessionDuration } from '../domain/validators.js';

export interface SessionRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const sessionRoutes: FastifyPluginAsync<SessionRouteOptions> = async (
  app: FastifyInstance,
  opts: SessionRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // ---------------------------------------------------------------------------
  // POST /sessions — create session cookie from ID token
  // ---------------------------------------------------------------------------

  app.post<{
    Body: { idToken: string; expiresIn: number };
  }>('/sessions', {
    config: { rateLimitClasses: ['mutation'] },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { idToken, expiresIn } = body as { idToken?: string; expiresIn?: number };

    if (!idToken || typeof idToken !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: idToken',
          requestId: request.requestId ?? '',
        },
      });
    }

    if (expiresIn === undefined || expiresIn === null || typeof expiresIn !== 'number') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: expiresIn',
          requestId: request.requestId ?? '',
        },
      });
    }

    const durationValidation = validateSessionDuration(expiresIn);
    if (!durationValidation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: durationValidation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    // Firebase SDK errors (invalid/expired ID token) propagate to error-handler → 401
    const sessionCookie = await firebaseAdapter.createSessionCookie(idToken, expiresIn);

    return reply.status(200).send({ sessionCookie, expiresIn });
  });

  // ---------------------------------------------------------------------------
  // POST /sessions/verify — verify a session cookie
  // ---------------------------------------------------------------------------

  app.post<{
    Body: { sessionCookie: string; checkRevoked?: boolean };
  }>('/sessions/verify', {
    config: { rateLimitClasses: ['read'] },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { sessionCookie, checkRevoked = false } = body as {
      sessionCookie?: string;
      checkRevoked?: boolean;
    };

    if (!sessionCookie || typeof sessionCookie !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: sessionCookie',
          requestId: request.requestId ?? '',
        },
      });
    }

    // Firebase SDK errors (invalid/expired/revoked cookie) propagate to error-handler → 401
    const decoded = await firebaseAdapter.verifySessionCookie(sessionCookie, checkRevoked);

    return reply.status(200).send(decoded);
  });
};

export default sessionRoutes;

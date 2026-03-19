import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirebaseAdapter } from '../domain/types.js';
import { validateUid, validateEmail, validatePhone } from '../domain/validators.js';

export interface UsersManagementRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

/** Allowed user property keys for create and update operations. */
const ALLOWED_USER_PROPS = new Set([
  'email',
  'password',
  'displayName',
  'phoneNumber',
  'photoURL',
  'disabled',
  'emailVerified',
]);

/**
 * Pick only whitelisted properties from the request body.
 * Returns the sanitised properties object and the list of field names present.
 */
function pickUserProperties(body: Record<string, unknown>): {
  properties: Record<string, unknown>;
  fields: string[];
} {
  const properties: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const key of Object.keys(body)) {
    if (ALLOWED_USER_PROPS.has(key)) {
      properties[key] = body[key];
      fields.push(key);
    }
  }
  return { properties, fields };
}

const usersManagementRoutes: FastifyPluginAsync<UsersManagementRouteOptions> = async (
  app: FastifyInstance,
  opts: UsersManagementRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // ---------------------------------------------------------------------------
  // POST /users — create a new user
  // ---------------------------------------------------------------------------

  app.post<{ Body: Record<string, unknown> }>(
    '/users',
    { config: { rateLimitClasses: ['mutation'] } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { properties, fields } = pickUserProperties(body);

      // Validate email if provided
      if (properties.email !== undefined) {
        if (typeof properties.email !== 'string') {
          return reply.status(400).send({
            error: {
              code: 400,
              message: 'email must be a string',
              requestId: request.requestId ?? '',
            },
          });
        }
        const emailValidation = validateEmail(properties.email);
        if (!emailValidation.valid) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: emailValidation.error!,
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      // Validate phone if provided
      if (properties.phoneNumber !== undefined) {
        if (typeof properties.phoneNumber !== 'string') {
          return reply.status(400).send({
            error: {
              code: 400,
              message: 'phoneNumber must be a string',
              requestId: request.requestId ?? '',
            },
          });
        }
        const phoneValidation = validatePhone(properties.phoneNumber);
        if (!phoneValidation.valid) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: phoneValidation.error!,
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      // Validate password length if provided (Firebase requires >= 6 chars)
      if (properties.password !== undefined) {
        if (typeof properties.password !== 'string' || properties.password.length < 6) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: 'Password must be a string of at least 6 characters',
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      // Firebase SDK errors (auth/email-already-exists → 409) handled by error-handler plugin
      const user = await firebaseAdapter.createUser(properties);

      app.emitAudit(request, {
        event: 'user.created',
        target: user.uid,
        changes: { fields },
      });

      return reply.status(201).send(user);
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /users/:uid — update user properties
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { uid: string }; Body: Record<string, unknown> }>(
    '/users/:uid',
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
      const { properties, fields } = pickUserProperties(body);

      if (fields.length === 0) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: 'No valid fields to update',
            requestId: request.requestId ?? '',
          },
        });
      }

      // Validate email if provided
      if (properties.email !== undefined) {
        if (typeof properties.email !== 'string') {
          return reply.status(400).send({
            error: {
              code: 400,
              message: 'email must be a string',
              requestId: request.requestId ?? '',
            },
          });
        }
        const emailValidation = validateEmail(properties.email);
        if (!emailValidation.valid) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: emailValidation.error!,
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      // Validate phone if provided
      if (properties.phoneNumber !== undefined) {
        if (typeof properties.phoneNumber !== 'string') {
          return reply.status(400).send({
            error: {
              code: 400,
              message: 'phoneNumber must be a string',
              requestId: request.requestId ?? '',
            },
          });
        }
        const phoneValidation = validatePhone(properties.phoneNumber);
        if (!phoneValidation.valid) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: phoneValidation.error!,
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      // Validate password if provided
      if (properties.password !== undefined) {
        if (typeof properties.password !== 'string' || properties.password.length < 6) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: 'Password must be a string of at least 6 characters',
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      // Firebase SDK errors (auth/email-already-exists → 409, auth/user-not-found → 404)
      // handled by error-handler plugin
      const user = await firebaseAdapter.updateUser(uid, properties);

      app.emitAudit(request, {
        event: 'user.updated',
        target: uid,
        changes: { fields },
      });

      return reply.status(200).send(user);
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /users/:uid — delete a user
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { uid: string } }>(
    '/users/:uid',
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

      // Firebase SDK errors (auth/user-not-found → 404) handled by error-handler plugin
      await firebaseAdapter.deleteUser(uid);

      app.emitAudit(request, {
        event: 'user.deleted',
        target: uid,
        changes: { fields: [] },
      });

      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // POST /users/:uid/disable — disable a user account (idempotent)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { uid: string } }>(
    '/users/:uid/disable',
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

      const user = await firebaseAdapter.updateUser(uid, { disabled: true });

      app.emitAudit(request, {
        event: 'user.disabled',
        target: uid,
        changes: { fields: ['disabled'] },
      });

      return reply.status(200).send(user);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /users/:uid/enable — enable a user account (idempotent)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { uid: string } }>(
    '/users/:uid/enable',
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

      const user = await firebaseAdapter.updateUser(uid, { disabled: false });

      app.emitAudit(request, {
        event: 'user.enabled',
        target: uid,
        changes: { fields: ['disabled'] },
      });

      return reply.status(200).send(user);
    },
  );
};

export default usersManagementRoutes;

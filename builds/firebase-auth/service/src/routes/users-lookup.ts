import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirebaseAdapter, UserIdentifier } from '../domain/types.js';
import {
  validateUid,
  validateEmail,
  validatePhone,
  validateBatchSize,
} from '../domain/validators.js';

export interface UsersLookupRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const BATCH_LOOKUP_MAX = 100;

const VALID_IDENTIFIER_KEYS = new Set(['uid', 'email', 'phoneNumber']);

const usersLookupRoutes: FastifyPluginAsync<UsersLookupRouteOptions> = async (
  app: FastifyInstance,
  opts: UsersLookupRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // ---------------------------------------------------------------------------
  // GET /users/:uid — lookup by UID
  // ---------------------------------------------------------------------------

  app.get<{ Params: { uid: string } }>(
    '/users/:uid',
    { config: { rateLimitClasses: ['read'] } },
    async (request, reply) => {
      const { uid } = request.params;

      const validation = validateUid(uid);
      if (!validation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: validation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }

      // Firebase SDK errors (auth/user-not-found → 404) handled by error-handler plugin
      const user = await firebaseAdapter.getUser(uid);
      return reply.status(200).send(user);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /users/by-email/:email — lookup by email
  // ---------------------------------------------------------------------------

  app.get<{ Params: { email: string } }>(
    '/users/by-email/:email',
    { config: { rateLimitClasses: ['read'] } },
    async (request, reply) => {
      const { email } = request.params;

      const validation = validateEmail(email);
      if (!validation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: validation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }

      const user = await firebaseAdapter.getUserByEmail(email);
      return reply.status(200).send(user);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /users/by-phone/:phoneNumber — lookup by phone (E.164)
  // Fastify auto-decodes path params, so both + and %2B work (Q-003).
  // ---------------------------------------------------------------------------

  app.get<{ Params: { phoneNumber: string } }>(
    '/users/by-phone/:phoneNumber',
    { config: { rateLimitClasses: ['read'] } },
    async (request, reply) => {
      const { phoneNumber } = request.params;

      const validation = validatePhone(phoneNumber);
      if (!validation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: validation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }

      const user = await firebaseAdapter.getUserByPhoneNumber(phoneNumber);
      return reply.status(200).send(user);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /users/batch — batch lookup up to 100 mixed identifiers (ADR-008)
  // ---------------------------------------------------------------------------

  app.post<{ Body: { identifiers: UserIdentifier[] } }>(
    '/users/batch',
    { config: { rateLimitClasses: ['batch'] } },
    async (request, reply) => {
      const { identifiers } = request.body ?? {};

      if (!Array.isArray(identifiers)) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: 'Missing required field: identifiers',
            requestId: request.requestId ?? '',
          },
        });
      }

      const batchValidation = validateBatchSize(identifiers, BATCH_LOOKUP_MAX);
      if (!batchValidation.valid) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: batchValidation.error!,
            requestId: request.requestId ?? '',
          },
        });
      }

      // Validate each identifier has exactly one key from {uid, email, phoneNumber}
      for (let i = 0; i < identifiers.length; i++) {
        const id = identifiers[i];
        if (!id || typeof id !== 'object') {
          return reply.status(400).send({
            error: {
              code: 400,
              message: `Invalid identifier at index ${i}: must be an object`,
              requestId: request.requestId ?? '',
            },
          });
        }

        const keys = Object.keys(id).filter((k) => VALID_IDENTIFIER_KEYS.has(k));
        if (keys.length !== 1) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: `Invalid identifier at index ${i}: must have exactly one key (uid, email, or phoneNumber)`,
              requestId: request.requestId ?? '',
            },
          });
        }

        const key = keys[0];
        const value = (id as Record<string, unknown>)[key];
        if (typeof value !== 'string') {
          return reply.status(400).send({
            error: {
              code: 400,
              message: `Invalid identifier at index ${i}: ${key} must be a string`,
              requestId: request.requestId ?? '',
            },
          });
        }

        let idValidation;
        if (key === 'uid') idValidation = validateUid(value);
        else if (key === 'email') idValidation = validateEmail(value);
        else idValidation = validatePhone(value);

        if (!idValidation.valid) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: `Invalid identifier at index ${i}: ${idValidation.error!}`,
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      const users = await firebaseAdapter.getUsers(identifiers);

      // Compute notFound by comparing input identifiers against returned users
      const foundUids = new Set(users.map((u) => u.uid));
      const foundEmails = new Set(
        users.map((u) => u.email).filter((e): e is string => e !== null),
      );
      const foundPhones = new Set(
        users.map((u) => u.phoneNumber).filter((p): p is string => p !== null),
      );

      const notFound: UserIdentifier[] = [];
      for (const id of identifiers) {
        if ('uid' in id && !foundUids.has(id.uid)) notFound.push(id);
        else if ('email' in id && !foundEmails.has(id.email)) notFound.push(id);
        else if ('phoneNumber' in id && !foundPhones.has(id.phoneNumber))
          notFound.push(id);
      }

      return reply.status(200).send({ users, notFound });
    },
  );
};

export default usersLookupRoutes;

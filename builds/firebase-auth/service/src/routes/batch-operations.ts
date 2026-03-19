import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirebaseAdapter } from '../domain/types.js';

export interface BatchOperationsRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const MAX_BATCH_DELETE = 1000;
const MAX_LIST_RESULTS = 1000;
const DEFAULT_LIST_RESULTS = 1000;

const batchOperationsRoutes: FastifyPluginAsync<BatchOperationsRouteOptions> = async (
  app: FastifyInstance,
  opts: BatchOperationsRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // ---------------------------------------------------------------------------
  // POST /users/batch-delete — bulk delete up to 1000 users
  // ---------------------------------------------------------------------------

  app.post<{ Body: { uids?: unknown } }>(
    '/users/batch-delete',
    { config: { rateLimitClasses: ['mutation', 'batch'] } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { uids } = body;

      if (!Array.isArray(uids)) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: 'uids must be an array of strings',
            requestId: request.requestId ?? '',
          },
        });
      }

      if (uids.length === 0) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: 'uids array must not be empty',
            requestId: request.requestId ?? '',
          },
        });
      }

      if (uids.length > MAX_BATCH_DELETE) {
        return reply.status(400).send({
          error: {
            code: 400,
            message: `uids array exceeds maximum of ${MAX_BATCH_DELETE}`,
            requestId: request.requestId ?? '',
          },
        });
      }

      // Validate all entries are strings
      for (let i = 0; i < uids.length; i++) {
        if (typeof uids[i] !== 'string') {
          return reply.status(400).send({
            error: {
              code: 400,
              message: `uids[${i}] must be a string`,
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      const result = await firebaseAdapter.deleteUsers(uids as string[]);

      app.emitAudit(request, {
        event: 'users.batch_deleted',
        target: String(result.successCount),
        changes: { fields: ['uids'] },
      });

      return reply.status(200).send({
        successCount: result.successCount,
        failureCount: result.failureCount,
        errors: result.errors.map((e) => ({
          index: e.index,
          message: e.error.message,
        })),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /users — paginated user listing
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { maxResults?: string; pageToken?: string } }>(
    '/users',
    { config: { rateLimitClasses: ['read', 'batch'] } },
    async (request, reply) => {
      const { maxResults: maxResultsStr, pageToken } = request.query;

      let maxResults = DEFAULT_LIST_RESULTS;

      if (maxResultsStr !== undefined) {
        maxResults = Number(maxResultsStr);
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_LIST_RESULTS) {
          return reply.status(400).send({
            error: {
              code: 400,
              message: `maxResults must be an integer between 1 and ${MAX_LIST_RESULTS}`,
              requestId: request.requestId ?? '',
            },
          });
        }
      }

      const result = await firebaseAdapter.listUsers(maxResults, pageToken);

      return reply.status(200).send({
        users: result.users,
        pageToken: result.pageToken ?? undefined,
      });
    },
  );
};

export default batchOperationsRoutes;

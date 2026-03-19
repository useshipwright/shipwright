import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { createRequire } from 'node:module';
import type { FirebaseAdapter } from '../domain/types.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

export interface HealthRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const healthRoute: FastifyPluginAsync<HealthRouteOptions> = async (
  app: FastifyInstance,
  opts: HealthRouteOptions,
) => {
  const { firebaseAdapter } = opts;
  const serviceVersion = process.env.BUILD_SHA ?? version;

  app.get('/health', async (_request, reply) => {
    const firebase = firebaseAdapter.isHealthy() ? 'connected' : 'error';

    return reply.status(200).send({
      status: 'ok',
      version: serviceVersion,
      uptime: process.uptime(),
      firebase,
    });
  });
};

export default healthRoute;

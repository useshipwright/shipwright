import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createRequire } from 'node:module';
import { healthSchema } from '../schemas/health.schema.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: healthSchema }, async (_request, reply) => {
    const firebaseInitialized = app.hasDecorator('firebaseAuth');

    return reply.code(200).send({
      status: firebaseInitialized ? 'healthy' : 'degraded',
      firebase_initialized: firebaseInitialized,
      version,
      timestamp: new Date().toISOString(),
    });
  });
}

export default fp(healthRoute, {
  name: 'health-route',
});

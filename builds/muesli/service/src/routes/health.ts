/**
 * Health check routes.
 *
 * GET /health — unauthenticated liveness probe. Returns { status: 'ok', version }.
 * GET /health/ready — readiness probe. Checks Firestore and GCS connectivity.
 *
 * No auth required on either endpoint.
 */

import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirestoreAdapter, GCSAdapter } from '../types/adapters.js';
import { logger } from '../logger.js';

// ── Plugin options ──────────────────────────────────────────────────

export interface HealthRoutesOptions {
  firestore: FirestoreAdapter;
  gcs: GCSAdapter;
}

// ── Route plugin ────────────────────────────────────────────────────

const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  app: FastifyInstance,
  opts: HealthRoutesOptions,
) => {
  const { firestore, gcs } = opts;

  // GET /health — liveness probe
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
    });
  });

  // GET /health/ready — readiness probe
  app.get('/health/ready', async (_request, reply) => {
    const checks = { firestore: false, gcs: false };

    try {
      checks.firestore = await firestore.healthCheck();
    } catch (err) {
      logger.warn({ err }, 'Firestore health check failed');
    }

    try {
      checks.gcs = await gcs.healthCheck();
    } catch (err) {
      logger.warn({ err }, 'GCS health check failed');
    }

    const allHealthy = checks.firestore && checks.gcs;
    const status = allHealthy ? 'ok' : 'degraded';

    return reply.status(allHealthy ? 200 : 503).send({ status, checks });
  });
};

export default healthRoutes;

/**
 * Health checks plugin (SI-002).
 *
 * GET /health      — Liveness probe. No auth. Returns { data: { status, version } }.
 * GET /health/ready — Readiness probe. No auth. Checks Firestore + GCS connectivity.
 *   Returns 200 { data: { status: 'ok', checks } } or 503 { data: { status: 'degraded', checks } }.
 *
 * Note (ADR-010): Cloud Run readiness probes are in Preview/Beta and require
 * run.googleapis.com/launch-stage: BETA annotation. Evaluate before production use.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fp from 'fastify-plugin';
import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { FirestoreAdapter, GCSAdapter } from '../types/adapters.js';
import { envelope } from '../utils/response.js';

function loadVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(dir, '../../package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface HealthPluginOptions {
  firestore?: FirestoreAdapter;
  gcs?: GCSAdapter;
  version?: string;
}

const healthPlugin: FastifyPluginAsync<HealthPluginOptions> = async (
  app: FastifyInstance,
  opts: HealthPluginOptions,
) => {
  const version = opts.version ?? loadVersion();

  app.get('/health', async (_request, reply) => {
    return reply.send(envelope({ status: 'ok', version }));
  });

  app.get('/health/ready', async (_request, reply) => {
    const [firestoreOk, gcsOk] = await Promise.all([
      opts.firestore?.healthCheck().catch(() => false) ?? false,
      opts.gcs?.healthCheck().catch(() => false) ?? false,
    ]);

    const status = firestoreOk && gcsOk ? 'ok' : 'degraded';
    const statusCode = status === 'ok' ? 200 : 503;

    return reply.code(statusCode).send(
      envelope({
        status,
        checks: {
          firestore: firestoreOk,
          gcs: gcsOk,
        },
      }),
    );
  });
};

export default fp(healthPlugin, {
  name: 'health-checks',
  fastify: '5.x',
});

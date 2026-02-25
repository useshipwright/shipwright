import Fastify, { type FastifyInstance } from 'fastify';
import type { Auth } from './adapters/firebase-admin.js';
import sensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import correlationId from './plugins/correlation-id.js';
import logging, { createLoggerConfig } from './plugins/logging.js';
import helmetPlugin from './plugins/helmet.js';
import corsPlugin from './plugins/cors.js';
import auditLogPlugin from './plugins/audit-log.js';
import metricsPlugin from './plugins/metrics.js';
import firebasePlugin from './plugins/firebase.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import { registerErrorHandler } from './errors.js';
import { registerRoutes } from './routes/index.js';

export interface AppDependencies {
  firebaseAuth?: Auth;
}

export interface BuildAppOptions {
  skipFirebaseInit?: boolean;
}

/**
 * Fastify app factory — assembles the full plugin graph.
 *
 * When skipFirebaseInit is false (default), registers the Firebase plugin
 * (or uses injected Auth) and enables all route plugins.
 * When true, registers only the health route (for health-only tests).
 */
export async function buildApp(
  opts: BuildAppOptions & AppDependencies = {},
): Promise<FastifyInstance> {
  const { skipFirebaseInit = false, firebaseAuth } = opts;

  const app = Fastify({
    logger: createLoggerConfig(),
    trustProxy: true,
  });

  // Core plugins (always registered)
  await app.register(sensible);
  await app.register(correlationId);
  await app.register(logging);
  await app.register(helmetPlugin);
  await app.register(corsPlugin);
  await app.register(auditLogPlugin);

  registerErrorHandler(app);

  if (!skipFirebaseInit) {
    if (firebaseAuth) {
      // Auth injected externally (from server.ts init or tests)
      await app.register(
        fp(
          async (instance) => {
            instance.decorate('firebaseAuth', firebaseAuth);
          },
          { name: 'firebase', dependencies: ['@fastify/sensible'] },
        ),
      );
    } else {
      // Plugin handles init from environment variables (ADR-004)
      await app.register(firebasePlugin);
    }

    await app.register(rateLimitPlugin);
  }

  await app.register(metricsPlugin);

  // Routes — health always; firebase-dependent routes conditionally
  await registerRoutes(app);

  return app;
}

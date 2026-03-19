import { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import type { AppConfig } from '../infra/config.js';

// Plugins — registered in ADR-005 order
import logRedactor from './log-redactor.js';
import requestContext from './request-context.js';
import metrics from './metrics.js';
import apiKeyAuth from './api-key-auth.js';
import rateLimiter from './rate-limiter.js';
import errorHandler from './error-handler.js';
import auditLogger from './audit-logger.js';

export interface PluginOptions {
  config: AppConfig;
}

/**
 * Register all application plugins in ADR-005 order.
 *
 * 1. log-redactor    — logger config at Fastify construction (decorators)
 * 2. request-context — onRequest, generates requestId
 * 3. metrics         — onRequest/onResponse, wraps all requests
 * 4. api-key-auth    — onRequest, after context, before everything else
 * 5. rate-limiter    — preHandler, after auth
 * 6. error-handler   — setErrorHandler, catches all
 * 7. audit-logger    — decorator, called explicitly by handlers
 *
 * Routes registered last (in routes/index.ts), after all plugins.
 */
export async function registerPlugins(app: FastifyInstance, opts: PluginOptions): Promise<void> {
  const cfg = opts.config;

  await app.register(helmet);
  await app.register(cors, { origin: cfg.corsOrigin || false });

  await app.register(logRedactor);
  await app.register(requestContext);
  await app.register(metrics);
  await app.register(apiKeyAuth);
  await app.register(rateLimiter, { config: cfg });
  await app.register(errorHandler);
  await app.register(auditLogger);
}

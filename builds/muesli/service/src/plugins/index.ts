import { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import auth from './auth.js';
import auditLog from './audit-log.js';
import errorHandler from './error-handler.js';
import health from './health.js';
import metrics from './metrics.js';
import multipart from './multipart.js';
import rateLimitPlugin from './rate-limit.js';
import websocket from './websocket.js';
import { config } from '../config.js';

/**
 * Register all application plugins.
 * Template contract: single entry point for plugin wiring.
 *
 * IMPORTANT: Import and register your Fastify plugins here.
 * Example:
 *   import correlationId from './correlation-id.js';
 *   await app.register(correlationId);
 *
 * Plugins not registered here are dead code — they will not execute.
 */
export async function registerPlugins(app: FastifyInstance): Promise<void> {
  // Error handler — sanitises responses, strips internal details
  await app.register(errorHandler);

  // Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
  await app.register(helmet);

  // CORS — set CORS_ORIGIN in production
  await app.register(cors, {
    origin: config.corsOrigin || true,
  });

  // Health check routes — /health, /health/ready (no auth)
  await app.register(health);

  // Auth middleware — Firebase JWT on /api/*, OIDC on /internal/*
  await app.register(auth);

  // Rate limiting (depends on auth for per-user keying)
  await app.register(rateLimitPlugin);

  // Multipart file uploads (500MB limit for audio)
  await app.register(multipart);

  // WebSocket support for live audio streaming
  await app.register(websocket);

  // Audit logging (SEC-10)
  await app.register(auditLog);

  // Prometheus metrics at /metrics (OBS-06)
  await app.register(metrics);

  // Register additional plugins below
}

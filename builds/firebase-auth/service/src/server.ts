/**
 * Process entry point — calls buildApp(), starts Fastify listen.
 * Handles SIGTERM/SIGINT for graceful shutdown so in-flight requests
 * are drained during Cloud Run rollouts or Docker stop.
 *
 * Firebase credential init is handled by the firebase plugin registered
 * inside buildApp() — credential isolation per REQ-006, ADR-001.
 */

import { buildApp } from './app.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Graceful shutdown — Fastify's app.close() drains in-flight connections
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Received signal, shutting down gracefully');
    const timer = setTimeout(() => {
      app.log.error('Shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);
    try {
      await app.close();
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'Uncaught exception, shutting down');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Unhandled rejection, shutting down');
    process.exit(1);
  });

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

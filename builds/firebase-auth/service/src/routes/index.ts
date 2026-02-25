import type { FastifyInstance } from 'fastify';
import healthRoute from './health.js';
import verifyRoute from './verify.js';
import batchVerifyRoute from './batch-verify.js';
import userLookupRoute from './user-lookup.js';

/**
 * Register all application routes.
 * Single entry point for route wiring — plugins not registered here will 404.
 *
 * Health route is always registered. Firebase-dependent routes (verify,
 * batch-verify, user-lookup) are registered only when the firebase decorator
 * is present, so callers must register the firebase plugin first.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute);

  // Firebase-dependent routes — require firebase plugin registered first
  if (app.hasDecorator('firebaseAuth')) {
    await app.register(verifyRoute);
    await app.register(batchVerifyRoute);
    await app.register(userLookupRoute);
  }
}

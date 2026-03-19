import { type FastifyInstance } from 'fastify';
import { type AppDependencies } from '../app.js';
import type { FirebaseAdapter } from '../domain/types.js';

import healthRoutes from './health.js';
import verifyRoutes from './verify.js';
import usersLookupRoutes from './users-lookup.js';
import usersManagementRoutes from './users-management.js';
import claimsRoutes from './claims.js';
import sessionRoutes from './sessions.js';
import tokenRoutes from './tokens.js';
import emailActionRoutes from './email-actions.js';
import batchOperationsRoutes from './batch-operations.js';

/**
 * Stub adapter for tests that don't provide a real firebaseAdapter.
 * All methods throw — tests are expected to mock individual methods.
 */
function createStubAdapter(): FirebaseAdapter {
  const stub = (): never => {
    throw new Error('Firebase adapter not initialized — provide deps.firebaseAdapter');
  };
  return {
    get projectId(): string { return 'stub'; },
    isHealthy: () => false,
    shutdown: async () => {},
    verifyIdToken: stub,
    getUser: stub,
    getUserByEmail: stub,
    getUserByPhoneNumber: stub,
    getUsers: stub,
    createUser: stub,
    updateUser: stub,
    deleteUser: stub,
    deleteUsers: stub,
    listUsers: stub,
    setCustomUserClaims: stub,
    revokeRefreshTokens: stub,
    createCustomToken: stub,
    createSessionCookie: stub,
    verifySessionCookie: stub,
    generatePasswordResetLink: stub,
    generateEmailVerificationLink: stub,
    generateSignInWithEmailLink: stub,
  };
}

/**
 * Register all application routes.
 * Routes registered last, after all plugins (ADR-005).
 */
export async function registerRoutes(
  app: FastifyInstance,
  deps: Partial<AppDependencies> = {},
): Promise<void> {
  const firebaseAdapter = deps.firebaseAdapter ?? createStubAdapter();

  await app.register(healthRoutes, { firebaseAdapter });
  await app.register(verifyRoutes, { firebaseAdapter });
  await app.register(usersLookupRoutes, { firebaseAdapter });
  await app.register(usersManagementRoutes, { firebaseAdapter });
  await app.register(claimsRoutes, { firebaseAdapter });
  await app.register(sessionRoutes, { firebaseAdapter });
  await app.register(tokenRoutes, { firebaseAdapter });
  await app.register(emailActionRoutes, { firebaseAdapter });
  await app.register(batchOperationsRoutes, { firebaseAdapter });
}

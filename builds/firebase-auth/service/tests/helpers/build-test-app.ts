/**
 * Shared test helper per ADR-011 — manual Fastify construction for route tests.
 *
 * Builds a Fastify instance with real sensible, correlation-id, and logging
 * plugins but a fake firebase plugin that decorates firebaseAuth with
 * vi.fn() mocks. Route tests use this instead of buildApp() which does not
 * register routes when skipFirebaseInit is true.
 */

import { vi, type Mock } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify';
import sensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import correlationId from '../../src/plugins/correlation-id.js';
import logging from '../../src/plugins/logging.js';
import rateLimitPlugin from '../../src/plugins/rate-limit.js';

export interface MockFirebaseAuth {
  verifyIdToken: Mock;
  getUser: Mock;
}

export interface TestApp {
  app: FastifyInstance;
  mocks: MockFirebaseAuth;
}

/**
 * Build a Fastify instance wired for route testing.
 *
 * Registers sensible, correlation-id, logging, and a fake firebase plugin
 * (fp with name 'firebase') that decorates firebaseAuth with mock functions.
 * Optionally registers the route plugin passed as parameter.
 *
 * @param routePlugin - The route plugin to register (e.g. verifyRoute)
 * @returns The Fastify instance and mock references for assertion
 */
export async function buildRouteTestApp(
  routePlugin?: FastifyPluginAsync,
): Promise<TestApp> {
  const mocks: MockFirebaseAuth = {
    verifyIdToken: vi.fn(),
    getUser: vi.fn(),
  };

  const fakeFirebasePlugin = fp(
    async (fastify: FastifyInstance) => {
      fastify.decorate('firebaseAuth', mocks);
    },
    { name: 'firebase' },
  );

  const app = Fastify({ logger: { level: 'silent' } });

  await app.register(sensible);
  await app.register(correlationId);
  await app.register(logging);
  await app.register(rateLimitPlugin);
  await app.register(fakeFirebasePlugin);

  if (routePlugin) {
    await app.register(routePlugin);
  }

  await app.ready();

  return { app, mocks };
}

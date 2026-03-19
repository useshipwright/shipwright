
import { buildApp } from '../../src/app.js';

/**
 * Create a configured test app instance.
 * Template contract: every stack template provides a test app factory.
 *
 * Usage in tests:
 *   const app = await buildTestApp();
 *   const res = await app.inject({ method: 'GET', url: '/health' });
 *   expect(res.statusCode).toBe(200);
 */
export async function buildTestApp() {
  const app = await buildApp();
  await app.ready();
  return app;
}

/**
 * Inject a request into the test app. Shorthand for app.inject().
 */
export async function injectRequest(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> },
) {
  return app.inject({
    method: opts.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    url: opts.url,
    payload: opts.payload,
    headers: opts.headers,
  });
}


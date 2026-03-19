import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  await app.register(requestContext);

  const { default: metricsPlugin } = await import('../../src/plugins/metrics.js');
  await app.register(metricsPlugin);

  // Add a dummy route so we can exercise HTTP metrics
  app.get('/test-route', async (_request, reply) => {
    return reply.status(200).send({ ok: true });
  });

  await app.ready();
  return app;
}

describe('metrics plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  describe('GET /metrics', () => {
    it('returns Prometheus text format', async () => {
      app = await buildTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(res.statusCode).toBe(200);
      // Prometheus text format content type
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('includes http_request_duration_seconds metric', async () => {
      app = await buildTestApp();

      // Make a request first to generate metrics
      await app.inject({ method: 'GET', url: '/test-route' });

      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = res.payload;
      expect(body).toContain('http_request_duration_seconds');
    });

    it('includes default Node.js metrics', async () => {
      app = await buildTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = res.payload;
      // prom-client collectDefaultMetrics produces process_cpu metrics
      expect(body).toContain('process_cpu');
    });

    it('records method, route, and status_code labels for HTTP requests', async () => {
      app = await buildTestApp();

      // Generate a data point
      await app.inject({ method: 'GET', url: '/test-route' });

      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = res.payload;
      expect(body).toContain('method="GET"');
      expect(body).toContain('status_code="200"');
    });
  });

  describe('rate_limit_exceeded_total counter', () => {
    it('is registered and can be incremented', async () => {
      app = await buildTestApp();

      // Import and call the function
      const { incrementRateLimitExceeded } = await import('../../src/plugins/metrics.js');
      incrementRateLimitExceeded('read');

      // The counter exists at module level on the default registry, not per-instance.
      // Verify it doesn't throw when called.
      expect(() => incrementRateLimitExceeded('mutation')).not.toThrow();
      expect(() => incrementRateLimitExceeded('batch')).not.toThrow();
    });
  });
});

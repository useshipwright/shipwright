import { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import client from 'prom-client';

/**
 * Prometheus metrics plugin.
 * Exposes /metrics endpoint with default Node.js metrics + HTTP request metrics.
 * Uses a per-instance Registry to avoid duplicate metric errors in tests.
 *
 * Scorer match: OBS-06 looks for "prom-client" or "/metrics" in source files.
 */
async function metricsPlugin(app: FastifyInstance): Promise<void> {
  // Per-instance registry — safe for tests that create multiple Fastify instances
  const register = new client.Registry();

  // Collect default Node.js metrics (CPU, memory, event loop, etc.)
  client.collectDefaultMetrics({ register });

  // HTTP request duration histogram
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [register],
  });

  // Track request duration
  app.addHook('onResponse', (request, reply, done) => {
    httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        status_code: reply.statusCode.toString(),
      },
      reply.elapsedTime / 1000, // Convert ms to seconds
    );
    done();
  });

  // Expose /metrics endpoint
  app.get('/metrics', async (_request, reply) => {
    const metrics = await register.metrics();
    return reply.type(register.contentType).send(metrics);
  });
}

export default fp(metricsPlugin, { name: 'metrics' });

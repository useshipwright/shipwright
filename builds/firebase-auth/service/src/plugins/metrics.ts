import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Registry, Histogram, collectDefaultMetrics } from 'prom-client';

async function metricsPlugin(app: FastifyInstance): Promise<void> {
  const registry = new Registry();

  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    httpDuration
      .labels(request.method, request.routeOptions.url || request.url, String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  app.get('/metrics', async (_request, reply) => {
    const metrics = await registry.metrics();
    return reply.type(registry.contentType).send(metrics);
  });
}

export default fp(metricsPlugin, { name: 'metrics' });
